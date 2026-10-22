import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { joinToken } from '../server/services/webinar-model.js';
import { sendDueReminders } from '../server/services/webinar-register.js';
import { newApp, readRun, runWorkflow, type T } from './wfx-helpers.js';

/**
 * The life of a webinar from registration to the numbers, with a virtual clock (`app.services.webinarNow`):
 * registration page and form, confirmation and reminders, the room (waiting, late entry, ended, replay), tracking,
 * questions into Konversationen, polls, the offer and the purchase behind it, and the end-of-session bookkeeping.
 * All mail and SMS go to the sub-account's "log" provider: nothing leaves the machine.
 */

const SECRET = 'test-secret';
const MONDAY = '2026-11-09T18:00:00.000Z'; // 19:00 in Berlin
const clock = { ms: Date.parse('2026-11-06T12:00:00Z') }; // the Friday before
const tick = (iso: string) => (clock.ms = Date.parse(iso));
const at = (base: string, addS: number) => new Date(Date.parse(base) + addS * 1000).toISOString();

let t: T;
let loc = '';
let events: { type: string; data: any; locationId: string }[] = [];
let wid = '';
let slug = '';
let productId = '';

const tokenOf = (regId: string) => joinToken(SECRET, regId);
const regRow = (email: string, session = MONDAY) => t.app.db.get<any>(`SELECT r.* FROM webinar_registrations r JOIN contacts c ON c.id = r.contact_id WHERE r.webinar_id = ? AND c.email = ? AND r.session_start = ?`, wid, email, session)!;
const raw = (path: string, init?: RequestInit) => t.api.raw(path, init);
const getJson = async (path: string) => {
  const r = await raw(path);
  return { status: r.status, data: await r.json().catch(() => null) as any, headers: r.headers };
};
const post = async (path: string, body: unknown) => {
  const r = await raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
};
const ping = (slugName: string, token: string, body: Record<string, unknown> = {}) => post(`/api/public/webinars/${slugName}/ping`, { t: token, mode: 'live', ...body });
/** The JSON block a page hands its script. */
const configOf = (html: string) => JSON.parse(/<script type="application\/json" id="wb-cfg">(.*?)<\/script>/s.exec(html)![1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
const page = async (path: string) => {
  const r = await raw(path);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const registerPublic = (email: string, extra: Record<string, unknown> = {}) => post(`/api/public/webinars/${slug}/register`, { first_name: 'Erika', last_name: 'Muster', email, consent: true, session: MONDAY, tz: 'Europe/Berlin', ...extra });
const messagesOf = (email: string, source?: string) =>
  t.app.db.all<any>(`SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? ${source ? 'AND m.source = ?' : ''} ORDER BY m.created_at, m.rowid`, email, ...(source ? [source] : []));
const tagsOf = (email: string): string[] => JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE email = ? AND location_id = ?', email, loc)!.tags);
const eventsOf = (type: string, email?: string) => events.filter((e) => e.type === type && (!email || e.data.contact?.email === email));
const activitiesOf = (email: string, type: string) => t.app.db.all<any>(`SELECT a.* FROM activities a JOIN contacts c ON c.id = a.contact_id WHERE c.email = ? AND a.type = ?`, email, type);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.webinarNow = () => clock.ms;
  t.app.events.on('*', (e) => void events.push({ type: e.type, data: e.data, locationId: e.locationId }));
  productId = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 49000 })).data.id;
  const created = await t.api.post('/api/webinars', { title: 'Mehr Kunden mit <b>Webinaren</b>', description: 'Zeile eins\n\nZeile zwei', presenter_name: 'Erika Muster' });
  expect(created.status).toBe(200);
  wid = created.data.id;
  slug = created.data.slug;
  const set = await t.api.patch(`/api/webinars/${wid}`, {
    video: { type: 'url', url: 'https://cdn.example.com/webinar.mp4' },
    duration_s: 3600,
    schedule: { fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, horizon_days: 21, late_join_min: 30, max_per_session: 3 },
    settings: {
      room: { questions: true, polls: [{ id: 'poll1abc', at_s: 600, question: 'Wie viele Kunden hast du?', options: ['unter 10', '10 bis 100', 'über 100'], show_results: true }], scripted_enabled: false, scripted: [{ id: 'msg1abcd', at_s: 120, name: 'Anna', text: 'Tolle Folie!' }] },
      offer: { enabled: true, at_s: 1800, title: 'Kurs mit 20 % Rabatt', text: 'Nur heute', button_text: 'Jetzt buchen', target: { type: 'product', product_id: productId }, countdown_s: 900 },
      reminders: { items: [{ key: '24h', offset_min: 1440, email: true, sms: false }, { key: '1h', offset_min: 60, email: true, sms: true }, { key: '15m', offset_min: 15, email: true, sms: false }, { key: 'start', offset_min: 0, email: true, sms: false }] },
      replay: { enabled: true, hours: 48 },
      registration: { ask_phone: true },
    },
    status: 'published',
  });
  expect(set.status, JSON.stringify(set.data)).toBe(200);
});
afterAll(() => t.close());

describe('registration page', () => {
  it('shows the honest label, the sessions in the viewer zone and escapes everything', async () => {
    const p = await page(`/w/${slug}`);
    expect(p.status).toBe(200);
    expect(p.html).toContain('Automatisiertes Webinar');
    expect(p.html).toContain('Mehr Kunden mit &lt;b&gt;Webinaren&lt;/b&gt;');
    expect(p.html).not.toContain('<b>Webinaren</b>');
    expect(p.html).toContain(`<time datetime="${MONDAY}">`);
    expect(p.html).toContain('name="consent"');
    expect(p.html).toContain('Erika Muster');
    // a strict policy: scripts only with the page's nonce, no framing unless embedded, no indexing
    const csp = p.headers.get('content-security-policy')!;
    const nonce = /nonce-([\w-]+)/.exec(csp)![1];
    expect(p.html).toContain(`<script nonce="${nonce}">`);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(p.headers.get('x-robots-tag')).toContain('noindex');
    expect(p.headers.get('cache-control')).toBe('no-store');
    const embed = await page(`/w/${slug}?embed=1`);
    expect(embed.headers.get('content-security-policy')).toContain('frame-ancestors *');
  });

  it('is gone for drafts and unknown webinars', async () => {
    expect((await page('/w/gibt-es-nicht')).status).toBe(404);
    await t.api.patch(`/api/webinars/${wid}`, { status: 'draft' });
    expect((await page(`/w/${slug}`)).status).toBe(404);
    expect((await registerPublic('draft@example.com')).status).toBe(404);
    await t.api.patch(`/api/webinars/${wid}`, { status: 'published' });
    expect((await page(`/w/${slug}`)).status).toBe(200);
  });

  it('serves the sessions as JSON for other pages', async () => {
    const j = await getJson(`/api/public/webinars/${slug}`);
    expect(j.status).toBe(200);
    expect(j.data).toMatchObject({ slug, label: 'Automatisiertes Webinar', duration_s: 3600 });
    expect(j.data.sessions[0]).toMatchObject({ start: MONDAY, kind: 'fixed', full: false });
    expect(j.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('registering', () => {
  it('needs consent, a valid e-mail, a name and an offered session', async () => {
    expect((await registerPublic('a@example.com', { consent: false })).data.error).toMatch(/zustimmen|Einwilligung|stimme/i);
    expect((await registerPublic('kein-mail')).data.error).toMatch(/E-Mail/);
    expect((await registerPublic('b@example.com', { first_name: '' })).data.error).toMatch(/Vornamen/);
    expect((await registerPublic('c@example.com', { session: '2026-11-10T18:00:00.000Z' })).data.error).toMatch(/Termin/);
    expect(t.app.db.get('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', wid)!.n).toBe(0);
  });

  it('ignores bots that fill the hidden field', async () => {
    const r = await registerPublic('bot@example.com', { _hp: 'http://spam' });
    expect(r.status).toBe(200);
    expect(r.data.spam).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM contacts WHERE email = ?', 'bot@example.com')!.n).toBe(0);
  });

  it('creates the contact with tags and source, stores the registration, books the timeline and sends the confirmation with the calendar file', async () => {
    events = [];
    const r = await registerPublic('anna@example.com', { phone: '0170 1234567', sms_consent: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // the personal link goes by e-mail only – the page does not hand it out for a scheduled session
    expect(r.data).toMatchObject({ ok: true, created: true, session: { start: MONDAY, kind: 'fixed' } });
    expect(r.data.join_url).toBeUndefined();
    await t.app.events.flush();

    const c = t.app.db.get<any>('SELECT * FROM contacts WHERE email = ?', 'anna@example.com')!;
    expect(c.source).toBe('Webinar: Mehr Kunden mit <b>Webinaren</b>');
    expect(c.phone).toBe('+491701234567');
    expect(tagsOf('anna@example.com')).toContain('webinar-angemeldet');
    const reg = regRow('anna@example.com');
    expect(reg).toMatchObject({ status: 'registered', session_kind: 'fixed', tz: 'Europe/Berlin', source: 'page', sms_consent: 1 });
    expect(reg.consent_at).toBeTruthy();

    expect(activitiesOf('anna@example.com', 'webinar.registered')[0].summary).toMatch(/angemeldet/);
    expect(eventsOf('webinar.registered', 'anna@example.com')).toHaveLength(1);
    const ev = eventsOf('webinar.registered', 'anna@example.com')[0].data;
    expect(ev).toMatchObject({ webinarId: wid, webinar: { slug }, registrationId: reg.id, session: { start: MONDAY, kind: 'fixed', end: at(MONDAY, 3600) } });
    expect(ev.join_url).toContain(`/w/${slug}/watch?t=${encodeURIComponent(tokenOf(reg.id))}`);

    const mail = messagesOf('anna@example.com', 'Webinar-Bestätigung');
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ channel: 'email', direction: 'out' });
    expect(mail[0].subject).toBe('Du bist angemeldet: Mehr Kunden mit <b>Webinaren</b>');
    expect(mail[0].body).toContain('Hallo Erika,');
    expect(mail[0].body).toContain(`/w/${slug}/watch?t=`);
    expect(mail[0].body).toContain(`/w/${slug}/ics?t=`);
    expect(mail[0].body).toContain('Montag, 9. November 2026');
    expect(mail[0].body).toContain('19:00');
    expect(mail[0].body).toContain('automatisiertes Webinar');
  });

  it('registering twice for the same session changes nothing and does not hand out the link', async () => {
    const before = t.app.db.get<any>('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', wid)!.n;
    const again = await registerPublic('anna@example.com');
    expect(again.data).toMatchObject({ ok: true, created: false });
    expect(again.data.join_url).toBeUndefined();
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', wid)!.n).toBe(before);
    // the confirmation is not sent again within ten minutes
    await t.app.events.flush();
    expect(messagesOf('anna@example.com', 'Webinar-Bestätigung')).toHaveLength(1);
  });

  it('serves the calendar file for the personal link', async () => {
    const reg = regRow('anna@example.com');
    const r = await raw(`/w/${slug}/ics?t=${encodeURIComponent(tokenOf(reg.id))}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    const ics = await r.text();
    expect(ics).toContain('DTSTART:20261109T180000Z');
    expect(ics).toContain('TRIGGER:-PT15M');
    expect((await raw(`/w/${slug}/ics?t=${encodeURIComponent(tokenOf(reg.id))}x`)).status).toBe(404);
    expect((await raw(`/w/${slug}/ics`)).status).toBe(404);
  });

  it('stops at the number of seats and says so', async () => {
    expect((await registerPublic('ben@example.com')).status).toBe(200);
    expect((await registerPublic('cleo@example.com')).status).toBe(200);
    const full = await registerPublic('dora@example.com');
    expect(full.status).toBe(409);
    expect(full.data.error).toMatch(/ausgebucht/);
    const p = await page(`/w/${slug}`);
    expect(p.html).toContain('ausgebucht');
    expect(p.html).toMatch(/<input type="radio" name="session" value="2026-11-09T18:00:00.000Z" disabled>/);
    // the next Monday is free
    expect((await registerPublic('dora@example.com', { session: '2026-11-16T18:00:00.000Z' })).status).toBe(200);
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ? AND session_start = ?', wid, MONDAY)!.n).toBe(3);
  });

  it('a registration that is cancelled gives its seat back', async () => {
    const reg = regRow('cleo@example.com');
    const cancel = await t.api.del(`/api/webinars/${wid}/registrations/${reg.id}`);
    expect(cancel.status).toBe(200);
    expect(t.app.db.get<any>('SELECT status FROM webinar_registrations WHERE id = ?', reg.id)!.status).toBe('cancelled');
    expect((await registerPublic('dora2@example.com')).status).toBe(200);
    // the link of a cancelled registration no longer opens
    const gone = await page(`/w/${slug}/watch?t=${encodeURIComponent(tokenOf(reg.id))}`);
    expect(gone.status).toBe(410);
    expect(gone.html).toMatch(/abgesagt/);
  });

  it('cancelling by link needs a click on a page (a link scanner must not cancel it)', async () => {
    const reg = regRow('dora2@example.com');
    const tok = encodeURIComponent(tokenOf(reg.id));
    const ask = await page(`/w/${slug}/cancel?t=${tok}`);
    expect(ask.status).toBe(200);
    expect(ask.html).toContain('<form method="post"');
    expect(t.app.db.get<any>('SELECT status FROM webinar_registrations WHERE id = ?', reg.id)!.status).toBe('registered');
    const done = await raw(`/w/${slug}/cancel?t=${tok}`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(t.app.db.get<any>('SELECT status FROM webinar_registrations WHERE id = ?', reg.id)!.status).toBe('cancelled');
    expect(activitiesOf('dora2@example.com', 'webinar.cancelled')).toHaveLength(1);
  });
});

describe('reminders', () => {
  it('sends each one once, at its moment, to those who registered before it – and skips the stale ones', async () => {
    const anna = 'anna@example.com';
    // 24 hours before: Sunday 17:00 UTC
    tick(at(MONDAY, -86_400 - 30));
    await t.app.services.webinars.tick();
    expect(messagesOf(anna, 'Webinar-Erinnerung')).toHaveLength(0);
    tick(at(MONDAY, -86_400 + 60));
    const first = await t.app.services.webinars.tick();
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    let mails = messagesOf(anna, 'Webinar-Erinnerung');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Morgen: Mehr Kunden mit <b>Webinaren</b>');
    expect(mails[0].body).toContain('/watch?t=');
    // a second tick finds it taken
    tick(at(MONDAY, -86_400 + 120));
    await t.app.services.webinars.tick();
    expect(messagesOf(anna, 'Webinar-Erinnerung')).toHaveLength(1);

    // 1 hour before: e-mail and – because Anna agreed and left a phone number – an SMS
    tick(at(MONDAY, -3600 + 30));
    await t.app.services.webinars.tick();
    mails = messagesOf(anna, 'Webinar-Erinnerung');
    expect(mails.filter((m) => m.channel === 'email')).toHaveLength(2);
    const sms = mails.filter((m) => m.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toContain('startet in einer Stunde');
    // Ben did not agree to SMS
    expect(messagesOf('ben@example.com', 'Webinar-Erinnerung').filter((m) => m.channel === 'sms')).toHaveLength(0);
    expect(messagesOf('ben@example.com', 'Webinar-Erinnerung').filter((m) => m.channel === 'email')).toHaveLength(2);
  });

  it('does not send "24 hours before" to somebody who registers an hour before, nor reminders long after their moment', async () => {
    tick(at(MONDAY, -3600 + 600));
    expect((await registerPublic('late@example.com')).status).toBe(200);
    await t.app.events.flush();
    await t.app.services.webinars.tick();
    // the 1 h moment (18:00 UTC − 1 h = 17:00) is before the registration (17:10): skipped; 15 min is still to come
    expect(messagesOf('late@example.com', 'Webinar-Erinnerung')).toHaveLength(0);
    tick(at(MONDAY, -15 * 60 + 20));
    await t.app.services.webinars.tick();
    expect(messagesOf('late@example.com', 'Webinar-Erinnerung').map((m) => m.subject)).toEqual(['In 15 Minuten: Mehr Kunden mit <b>Webinaren</b>']);
    // a server that was off for hours does not send a stale "15 minutes" afterwards
    const n = messagesOf('anna@example.com', 'Webinar-Erinnerung').length;
    await sendDueReminders(t.app, new Date(at(MONDAY, -15 * 60 + 3 * 3600)));
    expect(messagesOf('anna@example.com', 'Webinar-Erinnerung').length).toBe(n);
  });

  it('respects "Nicht stören" and leaves registrations of unpublished webinars alone', async () => {
    const reg = regRow('ben@example.com');
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', reg.contact_id);
    tick(at(MONDAY, 5));
    await t.app.services.webinars.tick();
    const start = messagesOf('ben@example.com', 'Webinar-Erinnerung').filter((m) => m.subject.startsWith('Es geht los'));
    expect(start).toHaveLength(1);
    expect(start[0].status).toBe('failed');
    t.app.db.run('UPDATE contacts SET dnd = 0 WHERE id = ?', reg.contact_id);
  });
});

describe('the room', () => {
  const mondayCfg = async (email: string) => {
    const reg = regRow(email);
    const p = await page(`/w/${slug}/watch?t=${encodeURIComponent(tokenOf(reg.id))}`);
    return { reg, p, cfg: p.status === 200 ? configOf(p.html) : null };
  };

  it('waits with a countdown before the start', async () => {
    tick(at(MONDAY, -600));
    const { p, cfg } = await mondayCfg('anna@example.com');
    expect(p.status).toBe(200);
    expect(cfg.mode).toBe('live');
    expect(cfg.clock).toMatchObject({ state: 'waiting', starts_in_s: 600 });
    expect(cfg.server_now).toBe(clock.ms);
    expect(cfg.start).toBe(MONDAY);
    expect(cfg.label).toBe('Automatisiertes Webinar');
    expect(p.html).toContain('<div class="badge">Automatisiertes Webinar</div>');
    expect(p.html).toContain('id="count"');
    // the page loads the video from the room's own address or the linked file, scoped in the policy
    const csp = p.headers.get('content-security-policy')!;
    expect(csp).toContain("media-src 'self' blob: https:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(p.headers.get('referrer-policy')).toBe('no-referrer');
    // scripted messages are off by default and never sent along
    expect(cfg.features).toMatchObject({ scripted: false, counter: false, questions: true });
    expect(cfg.scripted).toEqual([]);
    expect(cfg.playback).toEqual({ kind: 'file', src: 'https://cdn.example.com/webinar.mp4', mime: 'video/mp4' });
  });

  it('refuses links that are not this webinar’s', async () => {
    expect((await page(`/w/${slug}/watch`)).status).toBe(404);
    expect((await page(`/w/${slug}/watch?t=abc`)).status).toBe(404);
    expect((await page(`/w/nicht-da/watch?t=abc`)).status).toBe(404);
    const other = await t.api.post('/api/webinars', { title: 'Anderes' });
    const reg = regRow('anna@example.com');
    expect((await page(`/w/${other.data.slug}/watch?t=${encodeURIComponent(tokenOf(reg.id))}`)).status).toBe(404);
  });

  it('counts a viewer as present when the video runs, books watch time from the heartbeats and starts late joiners at the current second', async () => {
    events = [];
    // 10 minutes in, Anna enters
    tick(at(MONDAY, 600));
    const { cfg } = await mondayCfg('anna@example.com');
    expect(cfg.clock).toMatchObject({ state: 'running', offset_s: 600 });
    const tok = tokenOf(regRow('anna@example.com').id);
    const p1 = await ping(slug, tok);
    expect(p1.status).toBe(200);
    expect(p1.data.clock).toMatchObject({ state: 'running', offset_s: 600 });
    expect(p1.data.server_now).toBe(clock.ms);
    await t.app.events.flush();
    let reg = regRow('anna@example.com');
    expect(reg.attended_at).toBeTruthy();
    expect(reg.first_off).toBe(600);
    expect(reg.watched_s).toBe(0);
    expect(eventsOf('webinar.attended', 'anna@example.com')).toHaveLength(1);
    expect(eventsOf('webinar.attended', 'anna@example.com')[0].data.offset_s).toBe(600);
    expect(tagsOf('anna@example.com')).toContain('webinar-teilgenommen');
    expect(activitiesOf('anna@example.com', 'webinar.attended')).toHaveLength(1);

    // heartbeats every 20 s add up; a gap of minutes does not count as watching
    for (let i = 1; i <= 3; i++) {
      tick(at(MONDAY, 600 + i * 20));
      await ping(slug, tok);
    }
    reg = regRow('anna@example.com');
    expect(reg.watched_s).toBe(60);
    expect(reg.last_off).toBe(660);
    tick(at(MONDAY, 1200));
    await ping(slug, tok);
    reg = regRow('anna@example.com');
    expect(reg.watched_s).toBe(60);
    expect(reg.last_off).toBe(1200);
    tick(at(MONDAY, 1220));
    await ping(slug, tok);
    expect(regRow('anna@example.com').watched_s).toBe(80);
    expect(regRow('anna@example.com').watch_pct).toBe(2);
    // a second heartbeat in the same second does not count twice, and "attended" fires once
    await ping(slug, tok);
    await t.app.events.flush();
    expect(eventsOf('webinar.attended', 'anna@example.com')).toHaveLength(1);
  });

  it('cannot be fooled by what the browser reports: live time comes from the clock', async () => {
    const tok = tokenOf(regRow('anna@example.com').id);
    const before = regRow('anna@example.com');
    tick(at(MONDAY, 1240));
    await ping(slug, tok, { pos: 99999, playing: true });
    const after = regRow('anna@example.com');
    expect(after.watched_s - before.watched_s).toBe(20);
    expect(after.replay_at).toBeNull();
  });

  it('turns late arrivals away after the window, but not the one who is already in', async () => {
    tick(at(MONDAY, 31 * 60));
    const ben = tokenOf(regRow('ben@example.com').id);
    const late = await ping(slug, ben);
    expect(late.data.clock.state).toBe('late');
    expect(regRow('ben@example.com').attended_at).toBeNull();
    const { cfg } = await mondayCfg('ben@example.com');
    expect(cfg.clock.state).toBe('late');
    const anna = await ping(slug, tokenOf(regRow('anna@example.com').id));
    expect(anna.data.clock.state).toBe('running');
  });

  it('shows the number of people in the room only when asked for – and then it is the real number', async () => {
    const tok = tokenOf(regRow('anna@example.com').id);
    expect((await ping(slug, tok)).data.counter).toBeUndefined();
    await t.api.patch(`/api/webinars/${wid}`, { settings: { room: { show_counter: true } } });
    const r = await ping(slug, tok);
    expect(r.data.counter).toBe(1);
    await t.api.patch(`/api/webinars/${wid}`, { settings: { room: { show_counter: false } } });
  });
});

describe('questions, polls and the offer', () => {
  const tok = () => tokenOf(regRow('anna@example.com').id);

  it('puts a question into Konversationen (channel Chat) and shows the team’s answer in the room', async () => {
    tick(at(MONDAY, 1900));
    events = [];
    const q = await post(`/api/public/webinars/${slug}/question`, { t: tok(), text: '  Gibt es die Folien   zum Download? ' });
    expect(q.status, JSON.stringify(q.data)).toBe(200);
    const msg = messagesOf('anna@example.com').find((m) => m.source === 'Webinar')!;
    expect(msg).toMatchObject({ channel: 'chat', direction: 'in', status: 'received', body: 'Gibt es die Folien zum Download?' });
    expect(msg.subject).toBe('Webinar-Frage: Mehr Kunden mit <b>Webinaren</b>');
    const conv = t.app.db.get<any>('SELECT * FROM conversations WHERE contact_id = ?', msg.contact_id)!;
    expect(conv.unread).toBeGreaterThanOrEqual(1);
    expect(conv.last_message).toContain('Folien');
    await t.app.events.flush();
    expect(eventsOf('message.inbound', 'anna@example.com')).toHaveLength(1);
    const stored = t.app.db.get<any>('SELECT * FROM webinar_questions WHERE registration_id = ?', regRow('anna@example.com').id)!;
    expect(stored.offset_s).toBe(1900);
    // too fast
    expect((await post(`/api/public/webinars/${slug}/question`, { t: tok(), text: 'Noch eine' })).status).toBe(429);
    tick(at(MONDAY, 1910));
    expect((await post(`/api/public/webinars/${slug}/question`, { t: tok(), text: '' })).status).toBe(400);
    expect((await post(`/api/public/webinars/${slug}/question`, { t: tok(), text: 'x'.repeat(1001) })).status).toBe(400);
    expect((await post(`/api/public/webinars/${slug}/question`, { t: 'kaputt', text: 'Hallo' })).status).toBe(404);

    // the team answers in the inbox (chat) – the room picks it up with the next heartbeat
    const answer = await t.api.post('/api/messages', { contact_id: msg.contact_id, channel: 'chat', body: 'Ja, die Folien kommen per Mail.' });
    expect(answer.status).toBe(200);
    const r = await ping(slug, tok());
    expect(r.data.answers.map((a: any) => a.body)).toEqual(['Ja, die Folien kommen per Mail.']);
    // listed for the team, too
    const list = (await t.api.get(`/api/webinars/${wid}/questions`)).data;
    expect(list[0]).toMatchObject({ email: 'anna@example.com', body: 'Gibt es die Folien zum Download?', offset_s: 1900 });
    expect(list[0].conversation_id).toBe(conv.id);
  });

  it('can switch questions off', async () => {
    await t.api.patch(`/api/webinars/${wid}`, { settings: { room: { questions: false } } });
    tick(at(MONDAY, 1920));
    expect((await post(`/api/public/webinars/${slug}/question`, { t: tok(), text: 'Hallo?' })).status).toBe(403);
    await t.api.patch(`/api/webinars/${wid}`, { settings: { room: { questions: true } } });
  });

  it('takes a vote once, validates the choice and shows the real results', async () => {
    const bad1 = await post(`/api/public/webinars/${slug}/vote`, { t: tok(), poll_id: 'poll1abc', choice: [7] });
    expect(bad1.status).toBe(400);
    expect((await post(`/api/public/webinars/${slug}/vote`, { t: tok(), poll_id: 'poll1abc', choice: [0, 1] })).status).toBe(400);
    expect((await post(`/api/public/webinars/${slug}/vote`, { t: tok(), poll_id: 'gibtsnicht', choice: [0] })).status).toBe(404);
    const v = await post(`/api/public/webinars/${slug}/vote`, { t: tok(), poll_id: 'poll1abc', choice: [1] });
    expect(v.data).toMatchObject({ ok: true, mine: [1], counts: [0, 1, 0] });
    // changing the mind does not change the result
    const again = await post(`/api/public/webinars/${slug}/vote`, { t: tok(), poll_id: 'poll1abc', choice: [2] });
    expect(again.data.mine).toEqual([1]);
    expect(again.data.counts).toEqual([0, 1, 0]);
    expect(activitiesOf('anna@example.com', 'webinar.poll')).toHaveLength(1);
    // the room remembers the answer
    const cfg = configOf((await page(`/w/${slug}/watch?t=${encodeURIComponent(tok())}`)).html);
    expect(cfg.polls[0]).toMatchObject({ mine: [1], counts: [0, 1, 0], at_s: 600 });
    // another viewer's page does not show results before they voted
    const ben = configOf((await page(`/w/${slug}/watch?t=${encodeURIComponent(tokenOf(regRow('ben@example.com').id))}`)).html);
    expect(ben.polls[0].counts).toBeNull();
  });

  it('leads the offer button to the product, counts the click once on the timeline and refuses after the deadline', async () => {
    events = [];
    const reg = regRow('anna@example.com');
    const cfg = configOf((await page(`/w/${slug}/watch?t=${encodeURIComponent(tok())}`)).html);
    expect(cfg.offer).toMatchObject({ enabled: true, at_s: 1800, title: 'Kurs mit 20 % Rabatt', button_text: 'Jetzt buchen' });
    // the deadline is real: start + 1800 s + 900 s
    expect(cfg.offer.deadline_ms).toBe(Date.parse(MONDAY) + 2700 * 1000);

    tick(at(MONDAY, 1950));
    const go = await raw(`/w/${slug}/go?t=${encodeURIComponent(tok())}`, { redirect: 'manual' });
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe(`http://localhost/buy/${productId}?email=anna%40example.com`);
    await raw(`/w/${slug}/go?t=${encodeURIComponent(tok())}`, { redirect: 'manual' });
    await t.app.events.flush();
    const row = regRow('anna@example.com');
    expect(row.cta_clicks).toBe(2);
    expect(row.cta_clicked_at).toBeTruthy();
    expect(eventsOf('webinar.cta_clicked', 'anna@example.com')).toHaveLength(1);
    expect(tagsOf('anna@example.com')).toContain('webinar-angebot-geklickt');
    expect(activitiesOf('anna@example.com', 'webinar.cta_clicked')).toHaveLength(1);

    // after the countdown the button no longer works – the scarcity is true, not a timer that resets
    tick(at(MONDAY, 2701));
    const late = await raw(`/w/${slug}/go?t=${encodeURIComponent(tok())}`, { redirect: 'manual' });
    expect(late.status).toBe(410);
    expect(await late.text()).toMatch(/beendet/);
    expect(regRow('anna@example.com').cta_clicks).toBe(2);
    expect(reg.cta_clicks).toBe(0);
  });

  it('books a purchase of the offered product to the webinar, but only after a click', async () => {
    const anna = regRow('anna@example.com');
    const ben = regRow('ben@example.com');
    t.app.events.emit(loc, 'product.purchased', { contactId: ben.contact_id, productId, amount_cents: 49000 });
    t.app.events.emit(loc, 'product.purchased', { contactId: anna.contact_id, productId: 'anderes-produkt', amount_cents: 1000 });
    t.app.events.emit(loc, 'product.purchased', { contactId: anna.contact_id, productId, amount_cents: 49000 });
    await t.app.events.flush();
    expect(regRow('ben@example.com').purchase_cents).toBe(0);
    const row = regRow('anna@example.com');
    expect(row).toMatchObject({ purchase_cents: 49000, purchase_count: 1 });
    expect(tagsOf('anna@example.com')).toContain('webinar-gekauft');
    expect(activitiesOf('anna@example.com', 'webinar.purchased')[0].summary).toContain('490,00 €');
  });
});

describe('after the session', () => {
  it('shows the ended state with the recording only once the session is over', async () => {
    tick(at(MONDAY, 3000));
    const tokA = encodeURIComponent(tokenOf(regRow('anna@example.com').id));
    const early = await page(`/w/${slug}/replay?t=${tokA}`);
    expect(early.status).toBe(200);
    expect(early.html).toMatch(/steht nach dem Webinar bereit/);
    const r = await ping(slug, tokenOf(regRow('anna@example.com').id), { mode: 'replay', pos: 5, playing: true });
    expect(r.status).toBe(410);

    tick(at(MONDAY, 3601));
    const done = await ping(slug, tokenOf(regRow('anna@example.com').id));
    expect(done.data.clock.state).toBe('ended');
    expect(done.data.replay.available).toBe(true);
    expect(done.data.replay.url).toContain(`/w/${slug}/replay?t=`);
    const cfg = configOf((await page(`/w/${slug}/watch?t=${tokA}`)).html);
    expect(cfg.clock.state).toBe('ended');
    expect(cfg.replay).toMatchObject({ available: true });
  });

  it('books the end of the session once: watch share for those who were there, "missed" for those who were not', async () => {
    events = [];
    tick(at(MONDAY, 3600 + 120));
    expect((await t.app.services.webinars.tick()).finalized).toBe(0);
    tick(at(MONDAY, 3600 + 6 * 60));
    const r = await t.app.services.webinars.tick();
    expect(r.finalized).toBe(3);
    await t.app.events.flush();
    expect(eventsOf('webinar.watched_percent', 'anna@example.com')).toHaveLength(1);
    const w = eventsOf('webinar.watched_percent', 'anna@example.com')[0].data;
    expect(w.percent).toBe(regRow('anna@example.com').watch_pct);
    expect(w.watched_s).toBeGreaterThan(0);
    expect(activitiesOf('anna@example.com', 'webinar.watched')[0].summary).toMatch(/% gesehen/);
    expect(eventsOf('webinar.missed', 'late@example.com')).toHaveLength(1);
    expect(eventsOf('webinar.missed', 'ben@example.com')).toHaveLength(1);
    expect(eventsOf('webinar.missed', 'ben@example.com')[0].data.replay_url).toContain('/replay?t=');
    expect(tagsOf('ben@example.com')).toContain('webinar-verpasst');
    expect(tagsOf('anna@example.com')).not.toContain('webinar-verpasst');
    expect(eventsOf('webinar.missed', 'anna@example.com')).toHaveLength(0);
    // nothing is booked twice
    const again = await t.app.services.webinars.tick();
    expect(again.finalized).toBe(0);
    await t.app.events.flush();
    expect(eventsOf('webinar.watched_percent', 'anna@example.com')).toHaveLength(1);
    expect(regRow('anna@example.com').finalized_at).toBeTruthy();
    expect(regRow('anna@example.com').left_at).toBeTruthy();
  });

  it('plays the recording for registered people: resumes, counts the first view once, closes after the validity', async () => {
    events = [];
    const ben = tokenOf(regRow('ben@example.com').id);
    const p = await page(`/w/${slug}/replay?t=${encodeURIComponent(ben)}`);
    expect(p.status).toBe(200);
    const cfg = configOf(p.html);
    expect(cfg).toMatchObject({ mode: 'replay', label: 'Aufzeichnung', resume_s: 0 });
    expect(p.html).toContain('<div class="badge">Aufzeichnung</div>');
    const first = await ping(slug, ben, { mode: 'replay', pos: 12, playing: true });
    expect(first.status).toBe(200);
    await t.app.events.flush();
    expect(eventsOf('webinar.replay_watched', 'ben@example.com')).toHaveLength(1);
    tick(at(MONDAY, 3600 + 6 * 60 + 20));
    await ping(slug, ben, { mode: 'replay', pos: 400, playing: true });
    const row = regRow('ben@example.com');
    expect(row.replay_pos_s).toBe(400);
    expect(row.replay_watched_s).toBe(20);
    await ping(slug, ben, { mode: 'replay', pos: 410, playing: true });
    await t.app.events.flush();
    expect(eventsOf('webinar.replay_watched', 'ben@example.com')).toHaveLength(1);
    // the next visit starts where he stopped
    const next = configOf((await page(`/w/${slug}/replay?t=${encodeURIComponent(ben)}`)).html);
    expect(next.resume_s).toBe(410);
    expect(tagsOf('ben@example.com')).toContain('webinar-replay');
    // 48 hours after the end it is over
    tick(at(MONDAY, 3600 + 48 * 3600 + 5));
    const gone = await page(`/w/${slug}/replay?t=${encodeURIComponent(ben)}`);
    expect(gone.status).toBe(410);
    expect(gone.html).toMatch(/nicht mehr verfügbar/);
    expect((await ping(slug, ben, { mode: 'replay', pos: 1, playing: true })).status).toBe(410);
  });

  it('counts registrations, show-up, watch time, drop-off, clicks, sales and revenue per session', async () => {
    const s = (await t.api.get(`/api/webinars/${wid}/stats`)).data;
    const monday = s.sessions.find((x: any) => x.start === MONDAY);
    expect(monday).toMatchObject({ kind: 'fixed', registrations: 3, attended: 1, seats: 3, cta_clicks: 2, cta_unique: 1, purchases: 1, revenue_cents: 49000, replay_views: 1 });
    // Anna was there; Ben and the late registrant did not come; the cancelled seats do not count
    expect(monday.show_up_rate).toBeCloseTo(1 / 3, 2);
    expect(monday.avg_watch_s).toBeGreaterThan(60);
    expect(s.totals).toMatchObject({ attended: 1, cta_clicks: 2, purchases: 1, revenue_cents: 49000, questions: 1, replay_views: 1, cancelled: 2 });
    expect(s.totals.registrations).toBe(s.sessions.reduce((n: number, x: any) => n + x.registrations, 0));
    expect(s.totals.conversion_rate).toBe(1);
    // the curve: Anna came in at 600 s and left around 1260–1370 s
    expect(s.dropoff).toHaveLength(21);
    expect(s.dropoff[0]).toMatchObject({ at_s: 0, viewers: 0 });
    expect(s.dropoff.find((p: any) => p.at_s === 900)).toMatchObject({ viewers: 1, share: 1 });
    expect(s.dropoff[20]).toMatchObject({ at_s: 3600, viewers: 0 });
    expect(s.polls[0]).toMatchObject({ question: 'Wie viele Kunden hast du?', total: 1, options: [{ label: 'unter 10', count: 0 }, { label: '10 bis 100', count: 1 }, { label: 'über 100', count: 0 }] });
  });
});

describe('sessions without a date', () => {
  it('"just in time" and "sofort starten" register for a start that exists only now', async () => {
    tick('2026-11-13T11:07:00Z');
    const other = await t.api.post('/api/webinars', { title: 'Sofort-Webinar', video: { type: 'url', url: 'https://cdn.example.com/a.mp4' }, duration_s: 1200, schedule: { ondemand: { enabled: true }, jit: { enabled: true, every_min: 15, from: '09:00', to: '21:00' } } });
    expect((await t.api.patch(`/api/webinars/${other.data.id}`, { status: 'published' })).status).toBe(200);
    const info = await getJson(`/api/public/webinars/${other.data.slug}`);
    expect(info.data.sessions.map((x: any) => `${x.kind}:${x.start}`)).toEqual(['ondemand:2026-11-13T11:07:00.000Z', 'jit:2026-11-13T11:15:00.000Z', 'jit:2026-11-13T11:30:00.000Z', 'jit:2026-11-13T11:45:00.000Z']);
    const jit = await post(`/api/public/webinars/${other.data.slug}/register`, { first_name: 'Jan', email: 'jan@example.com', consent: true, session: '2026-11-13T11:15:00.000Z' });
    expect(jit.status).toBe(200);
    expect(jit.data.session).toEqual({ start: '2026-11-13T11:15:00.000Z', kind: 'jit' });
    const now = await post(`/api/public/webinars/${other.data.slug}/register`, { first_name: 'Jana', email: 'jana@example.com', consent: true, session: 'ondemand' });
    expect(now.data.session).toEqual({ start: '2026-11-13T11:07:00.000Z', kind: 'ondemand' });
    // a session that starts now opens the room at once
    expect(now.data.join_url).toContain(`/w/${other.data.slug}/watch?t=`);
    const again = await post(`/api/public/webinars/${other.data.slug}/register`, { first_name: 'Jana', email: 'jana@example.com', consent: true, session: 'ondemand' });
    expect(again.data.created).toBe(false);
    const room = await page(new URL(now.data.join_url).pathname + new URL(now.data.join_url).search);
    expect(configOf(room.html).clock).toMatchObject({ state: 'running', offset_s: 0 });
    // an unknown start is refused
    expect((await post(`/api/public/webinars/${other.data.slug}/register`, { first_name: 'X', email: 'x@example.com', consent: true, session: '2026-11-13T11:20:00.000Z' })).status).toBe(400);
  });
});

describe('forms and workflows', () => {
  it('a form can register its senders for the next session', async () => {
    tick('2026-11-06T12:00:00Z');
    await t.api.patch(`/api/webinars/${wid}`, { schedule: { max_per_session: 0 } });
    const form = (await t.api.post('/api/forms', { name: 'Webinar-Formular' })).data;
    const set = await t.api.patch(`/api/webinars/${wid}`, { settings: { registration: { form_ids: [form.id, 'fremdes-formular1'] } } });
    // only forms of this sub-account stay
    expect(set.data.settings.registration.form_ids).toEqual([form.id]);
    const sub = await raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Frieda', email: 'frieda@example.com', consent: 'ja' }) });
    expect(sub.status).toBe(200);
    await t.app.events.flush();
    const reg = t.app.db.get<any>(`SELECT r.* FROM webinar_registrations r JOIN contacts c ON c.id = r.contact_id WHERE c.email = 'frieda@example.com' AND r.webinar_id = ?`, wid)!;
    expect(reg).toMatchObject({ source: 'form', session_start: MONDAY });
    await t.app.events.flush();
    expect(messagesOf('frieda@example.com', 'Webinar-Bestätigung')).toHaveLength(1);
  });

  it('workflow triggers carry the event data and filter by webinar and by watched share', async () => {
    const mk = async (type: string, config: Record<string, unknown>, tag: string) => {
      const wf = (await t.api.post('/api/workflows', { name: `wf ${type} ${tag}`, trigger: { type, config }, steps: [{ type: 'add_tag', tags: [tag] }, { type: 'set_variable', rows: [{ name: 'url', value: '{{event.replay_url}}' }, { name: 'pct', value: '{{event.percent}}' }] }] })).data;
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
      return wf.id as string;
    };
    const reg = await mk('webinar.registered', { webinar_id: wid }, 'wf-angemeldet');
    const regOther = await mk('webinar.registered', { webinar_id: 'ein-anderes-webinar' }, 'wf-anderes');
    const p50 = await mk('webinar.watched_percent', { webinar_id: wid, min_percent: 50 }, 'wf-50');
    const p0 = await mk('webinar.watched_percent', { min_percent: 0 }, 'wf-0');
    const p90 = await mk('webinar.watched_percent', { webinar_id: wid, min_percent: 90 }, 'wf-90');
    expect((await registerPublic('wf@example.com', { session: '2026-11-16T18:00:00.000Z' })).status).toBe(200);
    await t.app.events.flush();
    const c = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'wf@example.com'`)!;
    expect(readRun(t, reg, c.id).run?.status).toBe('completed');
    expect(readRun(t, reg, c.id).vars.url).toContain('/replay?t=');
    expect(readRun(t, regOther, c.id).run).toBeUndefined();
    expect(tagsOf('wf@example.com')).toContain('wf-angemeldet');

    // the watched-share trigger: 72 % starts min 50 and min 0, not min 90
    const wreg = t.app.db.get<any>(`SELECT * FROM webinar_registrations WHERE contact_id = ?`, c.id)!;
    t.app.events.emit(loc, 'webinar.watched_percent', { contactId: c.id, webinarId: wid, webinar: { id: wid }, registrationId: wreg.id, percent: 72, replay_url: 'https://example.com/r' });
    await t.app.events.flush();
    expect(readRun(t, p50, c.id).run?.status).toBe('completed');
    expect(Number(readRun(t, p50, c.id).vars.pct)).toBe(72);
    expect(readRun(t, p0, c.id).run).toBeDefined();
    expect(readRun(t, p90, c.id).run).toBeUndefined();
  });

  it('the action "Kontakt für Webinar anmelden" registers the contact of the run', async () => {
    tick('2026-11-06T12:00:00Z');
    const r = await runWorkflow(t, [{ type: 'webinar_register', webinar_id: wid, session: 'next' }, { type: 'add_tag', tags: ['danach'] }]);
    expect(r.run.status).toBe('completed');
    expect(r.log[0].result).toMatch(/Angemeldet: „Mehr Kunden mit <b>Webinaren<\/b>“, Montag, 9\. November 2026/);
    expect(r.vars.webinar_join_url).toContain(`/w/${slug}/watch?t=`);
    expect(r.vars.webinar_session).toBe(MONDAY);
    const row = t.app.db.get<any>('SELECT * FROM webinar_registrations WHERE contact_id = ? AND webinar_id = ?', r.contact.id, wid)!;
    expect(row.source).toBe('workflow');
    expect(t.app.db.get<any>(`SELECT * FROM audit_log WHERE action = 'webinars.registrations.create' AND entity_id = ?`, row.id)).toMatchObject({ actor: 'Workflow', location_id: loc });
    // the same contact again: no second registration
    const again = await runWorkflow(t, [{ type: 'webinar_register', webinar_id: wid }], { contact: { email: r.contact.email } });
    expect(again.log[0].result).toMatch(/War schon angemeldet/);
    // readable errors in the run log
    expect((await runWorkflow(t, [{ type: 'webinar_register' }])).log[0].error).toMatch(/Webinar wählen/);
    expect((await runWorkflow(t, [{ type: 'webinar_register', webinar_id: 'nix' }])).log[0].error).toMatch(/gibt es in diesem Sub-Account nicht/);
    // a contact without e-mail cannot be registered
    const noMail = await runWorkflow(t, [{ type: 'webinar_register', webinar_id: wid }], { contact: { email: '', phone: '+4915112345678' } });
    expect(noMail.log[0].error).toMatch(/E-Mail/);
  });
});

describe('the catalogue', () => {
  it('lists the six triggers and the action with descriptions', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const triggers = cat.triggers.filter((x: any) => x.type.startsWith('webinar.')).map((x: any) => x.type);
    expect(triggers.sort()).toEqual(['webinar.attended', 'webinar.cta_clicked', 'webinar.missed', 'webinar.registered', 'webinar.replay_watched', 'webinar.watched_percent']);
    const action = cat.actions.find((a: any) => a.type === 'webinar_register');
    expect(action).toMatchObject({ label: 'Kontakt für Webinar anmelden', category: 'content' });
    expect(action.fields.map((f: any) => f.type)).toContain('webinar');
    const wp = cat.triggers.find((x: any) => x.type === 'webinar.watched_percent');
    expect(wp.fields.map((f: any) => f.key)).toEqual(['webinar_id', 'min_percent']);
  });
});
