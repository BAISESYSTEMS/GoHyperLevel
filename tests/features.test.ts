import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { advanceDate, runRecurringInvoices } from '../server/modules/payments.js';
import { occurrenceToday, runDateTriggers } from '../server/modules/date-triggers.js';
import { parseDay, resumeAt } from '../server/services/workflow-engine.js';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../server/services/totp.js';

let t: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

describe('recurring invoices', () => {
  it('advances dates keeping the day of month', () => {
    expect(advanceDate('2026-01-31T09:00:00.000Z', 'month')).toBe('2026-02-28T09:00:00.000Z');
    expect(advanceDate('2026-03-15T00:00:00.000Z', 'quarter')).toBe('2026-06-15T00:00:00.000Z');
    expect(advanceDate('2028-02-29T00:00:00.000Z', 'year')).toBe('2029-02-28T00:00:00.000Z');
    expect(advanceDate('2026-10-01T00:00:00.000Z', 'week')).toBe('2026-10-08T00:00:00.000Z');
  });

  it('issues and sends the next invoice when due, once', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'abo@kunde.de', first_name: 'Abo' })).data;
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Website-Wartung', items: [{ name: 'Wartung', qty: 1, price_cents: 4900 }] })).data;
    const r = await t.api.patch(`/api/invoices/${inv.id}`, { recurring: { interval: 'month', next_at: new Date(Date.now() - 40 * 864e5).toISOString(), auto_send: true } });
    expect(r.data.recurring.interval).toBe('month');
    const created = await runRecurringInvoices(t.app);
    expect(created).toHaveLength(1);
    expect(await runRecurringInvoices(t.app)).toHaveLength(0);
    const detail = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(detail.children).toHaveLength(1);
    expect(detail.children[0].status).toBe('sent');
    expect(new Date(detail.recurring.next_at).getTime()).toBeGreaterThan(Date.now());
    const child = (await t.api.get(`/api/invoices/${created[0]}`)).data;
    expect(child.total_cents).toBe(5831);
    expect(child.number).not.toBe(inv.number);
    expect((await t.api.patch(`/api/invoices/${child.id}`, { recurring: { interval: 'month' } })).status).toBe(400);
    const subs = (await t.api.get('/api/subscriptions')).data;
    expect(subs[0]).toMatchObject({ id: inv.id, issued: 1 });
    const msgs = (await t.api.get(`/api/contacts/${c.id}/messages`)).data;
    expect(msgs.some((m: any) => m.subject.includes(child.number))).toBe(true);
    await t.api.patch(`/api/invoices/${inv.id}`, { recurring: null });
    expect((await t.api.get('/api/subscriptions')).data).toHaveLength(0);
  });

  it('stops after the end date', async () => {
    const inv = (await t.api.post('/api/invoices', { items: [{ name: 'X', price_cents: 100 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { recurring: { interval: 'week', next_at: new Date(Date.now() - 864e5).toISOString(), end_at: new Date(Date.now() + 864e5).toISOString(), auto_send: false } });
    expect(await runRecurringInvoices(t.app)).toHaveLength(1);
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data.recurring.active).toBe(false);
  });
});

describe('email tracking and trigger links', () => {
  it('tracks opens and clicks of campaign mails and starts workflows', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'leser@x.de', first_name: 'Lea', tags: ['nl'] })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'Klicker', trigger: { type: 'email.clicked', config: {} }, steps: [{ type: 'add_tag', tags: ['hat-geklickt'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const camp = (await t.api.post('/api/campaigns', { name: 'News', subject: 'Hallo', body: 'Neu: https://example.com/angebot?x=1&y=2 und https://example.com/blog', filter: { tags: ['nl'] } })).data;
    await t.api.post(`/api/campaigns/${camp.id}/send`);
    const links = t.app.db.all('SELECT * FROM tracked_links WHERE contact_id = ?', c.id);
    expect(links.map((l) => l.url).sort()).toEqual(['https://example.com/angebot?x=1&y=2', 'https://example.com/blog']);
    const msg = t.app.db.get('SELECT id FROM messages WHERE contact_id = ? ORDER BY created_at DESC', c.id)!;
    // A person reads the mail an hour later in a browser (an open or click seconds after sending is a prefetch or scanner: see email-tracking.test.ts).
    t.app.db.run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Date.now() - 3600_000).toISOString(), msg.id);
    const person = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'accept-language': 'de-DE,de;q=0.9' };
    const px = await t.api.raw(`/t/o/${msg.id}.gif`, { headers: person });
    expect(px.headers.get('content-type')).toBe('image/gif');
    const click = await t.api.raw(`/t/c/${links[0].id}`, { redirect: 'manual', headers: person });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe(links[0].url);
    t.app.services.trackingCommit({ force: true });
    await t.app.events.flush();
    const eng = (await t.api.get(`/api/campaigns/${camp.id}/engagement`)).data;
    expect(eng).toMatchObject({ sent: 1, opened: 1, clicked: 1, open_rate: 100 });
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.tags).toContain('hat-geklickt');
    expect((await t.api.raw('/t/c/nope')).status).toBe(404);
  });

  it('personalizes trigger links in messages and tags on click', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'tl@x.de', phone: '+49151000' })).data;
    const link = (await t.api.post('/api/trigger-links', { name: 'Webinar', url: 'https://example.com/webinar', tags: ['webinar-interesse'] })).data;
    expect(link.short_url).toBe('http://localhost/l/webinar');
    await t.api.post('/api/messages', { contact_id: c.id, channel: 'sms', body: `Hier anmelden: ${link.short_url} – bis bald` });
    // The stored SMS keeps the plain link; the sent one was personal. Rebuild it the same way:
    const personal = t.app.services.personalizeLinks(t.api.location, c.id, `x ${link.short_url} y`);
    expect(personal).toMatch(new RegExp(`/l/webinar/${c.id}\\.[0-9a-f]{16} y$`));
    const path = new URL(personal.split(' ')[1]).pathname;
    const r = await t.api.raw(path, { redirect: 'manual' });
    expect(r.headers.get('location')).toBe('https://example.com/webinar');
    await t.app.events.flush();
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.tags).toContain('webinar-interesse');
    // A forged signature still redirects but tags nobody.
    const forged = await t.api.raw(`/l/webinar/${c.id}.0000000000000000`, { redirect: 'manual' });
    expect(forged.status).toBe(302);
    const stats = (await t.api.get('/api/trigger-links')).data[0];
    expect(stats).toMatchObject({ clicks: 2, unique_contacts: 1 });
  });
});

describe('calendar sync (iCal)', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART:20301007T080000Z',
    'DTEND:20301007T090000Z',
    'SUMMARY:Zahnarzt',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'DTSTART;TZID=Europe/Berlin:20301008T140000',
    'DTEND;TZID=Europe/Berlin:20301008T153000',
    'SUMMARY:Kunde',
    ' mit Fortsetzung',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c',
    'DTSTART;VALUE=DATE:20301010',
    'DTEND;VALUE=DATE:20301011',
    'SUMMARY:Urlaub',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:d',
    'DTSTART;TZID=W. Europe Standard Time:20300930T100000',
    'DTEND;TZID=W. Europe Standard Time:20300930T103000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
    'EXDATE;TZID=W. Europe Standard Time:20301002T100000',
    'SUMMARY:Jour fixe',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:e',
    'DTSTART:20301007T120000Z',
    'DTEND:20301007T130000Z',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('parses single, zoned, all-day and repeating events', async () => {
    const { parseIcsBusy } = await import('../server/services/ical.js');
    const ev = parseIcsBusy(ics, new Date('2030-09-01'), new Date('2030-12-31'), 'Europe/Berlin');
    const by = (uid: string) => ev.filter((e) => e.uid === uid);
    expect(by('a')[0]).toMatchObject({ start_at: '2030-10-07T08:00:00.000Z', end_at: '2030-10-07T09:00:00.000Z' });
    expect(by('b')[0]).toMatchObject({ start_at: '2030-10-08T12:00:00.000Z', summary: 'Kundemit Fortsetzung' });
    expect(by('c')[0].start_at).toBe('2030-10-09T22:00:00.000Z');
    expect(by('e')).toHaveLength(0);
    // Mo/Mi from 30.9., 6 times, minus the EXDATE on 2.10. -> 5 occurrences, 10:00 Berlin
    expect(by('d').map((e) => e.start_at)).toEqual(['2030-09-30T08:00:00.000Z', '2030-10-07T08:00:00.000Z', '2030-10-09T08:00:00.000Z', '2030-10-14T08:00:00.000Z', '2030-10-16T08:00:00.000Z']);
  });

  it('blocks imported times on the booking page and exports a feed', async () => {
    const { syncCalendar, importUrl } = await import('../server/modules/calendar-sync.js');
    expect(() => importUrl('http://example.com/x.ics')).toThrow();
    expect(() => importUrl('https://127.0.0.1/x.ics')).toThrow();
    expect(importUrl('webcal://calendar.google.com/x/basic.ics')).toBe('https://calendar.google.com/x/basic.ics');
    const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    const busy = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Europe/Berlin:${day}T000000\r\nDTEND;TZID=Europe/Berlin:${day}T235900\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const cal = (await t.api.post('/api/calendars', { name: 'Sync-Test', min_notice: 0, availability: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]])) })).data;
    const ymd = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
    const before = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${ymd}&days=1`)).data.days[0].slots.length;
    expect(before).toBeGreaterThan(0);
    t.app.db.run(`UPDATE calendars SET settings = json_set(settings, '$.ical_import', json(?)) WHERE id = ?`, JSON.stringify(['https://calendar.example.com/private.ics']), cal.id);
    const fake = (async () => new Response(busy, { status: 200 })) as unknown as typeof fetch;
    const status = await syncCalendar(t.app, cal.id, fake);
    expect(status).toMatchObject({ ok: true, events: 1 });
    expect((await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${ymd}&days=1`)).data.days[0].slots).toHaveLength(0);
    const feed = (await t.api.get(`/api/calendars/${cal.id}/feed`)).data;
    const r = await t.api.raw(new URL(feed.url).pathname);
    expect(await r.text()).toContain('X-WR-CALNAME:Sync-Test');
    expect((await t.api.raw('/cal/falsch.ics')).status).toBe(404);
    const bad = await t.api.post(`/api/calendars/${cal.id}/sync`, { urls: ['http://unsicher.de/a.ics'] });
    expect(bad.status).toBe(400);
  });
});

describe('website SEO', () => {
  it('serves sitemap, robots, social tags and a friendly 404 on the custom domain', async () => {
    const { request } = await import('node:http');
    const get = (path: string, host: string) =>
      new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
        const u = new URL(t.base);
        request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, type: String(res.headers['content-type']) }));
        })
          .on('error', reject)
          .end();
      });
    const f = (await t.api.post('/api/funnels', { name: 'SEO-Site', kind: 'website', template: 'website' })).data;
    await t.api.patch(`/api/funnels/${f.id}`, { domain: 'seo-kunde.de', settings: { description: 'Malerbetrieb in Köln', og_image: 'https://img.example/og.jpg', site_name: 'Maler Meier' } });
    const dsgvo = f.pages.find((p: any) => p.slug === 'datenschutz');
    await t.api.patch(`/api/funnel-pages/${dsgvo.id}`, { seo: { noindex: true } });

    const home = await get('/', 'seo-kunde.de');
    expect(home.body).toContain('<link rel="canonical" href="https://seo-kunde.de/">');
    expect(home.body).toContain('<meta property="og:image" content="https://img.example/og.jpg">');
    expect(home.body).toContain('<meta property="og:description" content="Malerbetrieb in Köln">');
    expect((await get('/datenschutz', 'seo-kunde.de')).body).toContain('noindex');
    const sm = await get('/sitemap.xml', 'www.seo-kunde.de');
    expect(sm.type).toContain('xml');
    expect(sm.body).toContain('<loc>https://seo-kunde.de/</loc>');
    expect(sm.body).toContain('<loc>https://seo-kunde.de/impressum</loc>');
    expect(sm.body).not.toContain('datenschutz');
    expect((await get('/robots.txt', 'seo-kunde.de')).body).toContain('Sitemap: https://seo-kunde.de/sitemap.xml');
    const missing = await get('/gibts-nicht', 'seo-kunde.de');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('Zur Startseite');
  });
});

describe('backups', () => {
  it('makes a backup on the first tick, keeps the newest, downloads for admins', async () => {
    const { listBackups, makeBackup } = await import('../server/modules/backups.js');
    expect(listBackups(t.app)).toHaveLength(0);
    await t.app.tick();
    expect(listBackups(t.app)).toHaveLength(1);
    await t.app.tick();
    expect(listBackups(t.app)).toHaveLength(1); // not again within 24h
    process.env.PGHL_BACKUP_KEEP = '2';
    makeBackup(t.app, new Date(Date.now() + 1000));
    makeBackup(t.app, new Date(Date.now() + 2000));
    expect(listBackups(t.app)).toHaveLength(2);
    delete process.env.PGHL_BACKUP_KEEP;
    const list = (await t.api.get('/api/admin/backups')).data.backups;
    const dl = await t.api.get(`/api/admin/backups/${list[0].name}`);
    expect(dl.status).toBe(200);
    expect((await t.api.get('/api/admin/backups/..%2Fpghl.db')).status).toBe(404);
  });
});

describe('live chat', () => {
  const post = (body: any) =>
    t.api.raw(`/api/public/chat/${t.api.location}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('is off until enabled', async () => {
    expect(await (await t.api.raw(`/chat/${t.api.location}/widget.js`)).text()).toContain('chat off');
    expect((await post({ body: 'Hallo' })).status).toBe(404);
  });

  it('carries messages both ways and starts workflows', async () => {
    await t.api.patch('/api/location', { settings: { chat: { enabled: true, color: '#ff0066', ask_email: true } } });
    const js = await (await t.api.raw(`/chat/${t.api.location}/widget.js`)).text();
    expect(js).toContain('#ff0066');
    expect(js).toContain('/frame');
    const frame = await t.api.raw(`/chat/${t.api.location}/frame`);
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain('/api/public/chat/');
    expect((await post({ body: 'x', email: 'kaputt' })).status).toBe(400);

    const wf = (await t.api.post('/api/workflows', { name: 'Chat', trigger: { type: 'message.inbound', config: {} }, steps: [{ type: 'add_tag', tags: ['chat-lead'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const first = await (await post({ body: 'Was kostet eine Website?', name: 'Chat Kundin', email: 'chat@kunde.de' })).json();
    expect(first.visitor).toMatch(/\w{10,}/);
    await post({ body: 'Und wie lange dauert es?', visitor: first.visitor });

    const contact = (await t.api.get('/api/contacts?q=chat@kunde.de')).data.contacts?.[0] ?? (await t.api.get('/api/contacts?q=chat@kunde.de')).data[0];
    expect(contact.source).toBe('Live-Chat');
    const conv = (await t.api.get('/api/conversations')).data.find((v: any) => v.contact_id === contact.id);
    expect(conv.unread).toBe(2);
    const reply = (await t.api.post('/api/messages', { contact_id: contact.id, channel: 'chat', body: 'Ab 990 €, ca. 2 Wochen.' })).data;
    expect(reply.status).toBe('sent');

    const seen = await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=${first.visitor}`)).json();
    expect(seen.messages.map((m: any) => m.direction)).toEqual(['in', 'in', 'out']);
    expect(seen.messages[2].body).toContain('990');
    const later = await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=${first.visitor}&after=${encodeURIComponent(seen.messages[1].created_at)}`)).json();
    expect(later.messages).toHaveLength(1);
    expect((await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=fremd`)).json()).messages).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 50));
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.tags).toContain('chat-lead');
  });
});

describe('forms: conditions and file uploads', () => {
  it('only requires and stores visible fields, keeps files private', async () => {
    const form = (
      await t.api.post('/api/forms', {
        name: 'Projektanfrage',
        fields: [
          { id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true },
          { id: 'b', type: 'radio', label: 'Art', name: 'art', options: ['Website', 'Shop'], required: true },
          { id: 'c', type: 'number', label: 'Anzahl Produkte', name: 'produkte', required: true, show_if: { field: 'art', op: 'eq', value: 'Shop' } },
          { id: 'd', type: 'file', label: 'Briefing', name: 'briefing' },
        ],
      })
    ).data;
    expect(form.fields[2].show_if).toEqual({ field: 'art', op: 'eq', value: 'Shop' });
    const page = await (await t.api.raw(`/f/${form.id}`)).text();
    expect(page).toContain('data-show=');
    expect(page).toContain('type="file"');
    const submit = (body: any) => t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // Hidden field: neither required nor stored even if sent.
    expect((await submit({ email: 'web@x.de', art: 'Website', produkte: '99' })).status).toBe(200);
    expect((await submit({ email: 'shop@x.de', art: 'Shop' })).status).toBe(400);

    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 briefing').toString('base64');
    expect((await submit({ email: 'shop@x.de', art: 'Shop', produkte: '40', briefing: { name: 'x.html', type: 'text/html', data: 'data:text/html;base64,PGI+' } })).status).toBe(400);
    expect((await submit({ email: 'shop@x.de', art: 'Shop', produkte: '40', briefing: { name: 'Briefing ä.pdf', type: 'application/pdf', data: pdf } })).status).toBe(200);

    const subs = (await t.api.get(`/api/forms/${form.id}/submissions`)).data;
    const web = subs.find((x: any) => x.data['E-Mail'] === 'web@x.de');
    expect(web.data['Anzahl Produkte']).toBeUndefined();
    const shop = subs.find((x: any) => x.data['E-Mail'] === 'shop@x.de');
    const url = new URL(shop.data.Briefing);
    expect(url.pathname).toMatch(/^\/api\/form-files\//);
    expect((await t.api.raw(url.pathname)).status).toBe(401);
    const file = await t.api.raw(url.pathname + url.search, { headers: { cookie: t.api.cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain("filename*=UTF-8''Briefing%20%C3%A4.pdf");
    expect(await file.text()).toContain('briefing');
  });
});

describe('date triggers and wait until', () => {
  const tz = 'Europe/Berlin';
  it('parses dates and finds yearly occurrences', () => {
    expect(parseDay('7.3.1990')).toBe('1990-03-07');
    expect(parseDay('1990-03-07T00:00:00Z')).toBe('1990-03-07');
    expect(parseDay('morgen')).toBeNull();
    expect(occurrenceToday('1990-03-07', 0, true, '2026-03-07')).toBe('2026-03-07');
    expect(occurrenceToday('1990-03-07', -3, true, '2026-03-04')).toBe('2026-03-07');
    expect(occurrenceToday('1990-12-31', 2, true, '2027-01-02')).toBe('2026-12-31');
    expect(occurrenceToday('1992-02-29', 0, true, '2026-02-28')).toBe('2026-02-28');
    expect(occurrenceToday('2026-05-01', 0, false, '2027-05-01')).toBeNull();
  });

  it('computes when a wait step resumes', () => {
    const from = new Date('2026-10-01T12:00:00Z'); // Thursday, 14:00 in Berlin
    const contact = { date_of_birth: '1985-10-05', custom: { vertragsende: '2027-01-31' } };
    expect(resumeAt({ id: 'w', type: 'wait', amount: 2, unit: 'hours' }, {}, tz, from)?.toISOString()).toBe('2026-10-01T14:00:00.000Z');
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'date', date: '2026-10-10', time: '08:30' }, {}, tz, from)?.toISOString()).toBe('2026-10-10T06:30:00.000Z');
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'date', date: '2026-09-10' }, {}, tz, from)).toBeNull();
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'field', field: 'date_of_birth', yearly: true }, { contact }, tz, from)?.toISOString()).toBe('2026-10-05T07:00:00.000Z');
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'field', field: 'custom.vertragsende', offset_days: -30 }, { contact }, tz, from)?.toISOString()).toBe('2027-01-01T08:00:00.000Z');
    // Thursday 14:00 → Friday 09:00 (Mon–Fri default), Saturday-only → Saturday
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'weekday', time: '09:00' }, {}, tz, from)?.toISOString()).toBe('2026-10-02T07:00:00.000Z');
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'weekday', days: ['thu'], time: '15:00' }, {}, tz, from)?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    expect(resumeAt({ id: 'w', type: 'wait', mode: 'weekday', days: ['sat'], time: '10:00' }, {}, tz, from)?.toISOString()).toBe('2026-10-03T08:00:00.000Z');
  });

  it('starts birthday workflows once per year', async () => {
    const at = new Date();
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const c = (await t.api.post('/api/contacts', { email: 'geburtstag@x.de', first_name: 'Gabi', date_of_birth: `1990${today.slice(4)}` })).data;
    await t.api.post('/api/contacts', { email: 'anderer@x.de', date_of_birth: '1990-01-01' === `1990${today.slice(4)}` ? '1990-06-15' : '1990-01-01' });
    const wf = (await t.api.post('/api/workflows', { name: 'Geburtstag', trigger: { type: 'date.reached', config: { field: 'date_of_birth', time: '00:00' } }, steps: [{ type: 'add_tag', tags: ['geburtstag-gratuliert'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect(await runDateTriggers(t.app, at)).toBe(1);
    expect(await runDateTriggers(t.app, at)).toBe(0);
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.tags).toContain('geburtstag-gratuliert');
  });
});

describe('two-factor login', () => {
  it('matches the RFC test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(['755224', '287082', '359152'].map((c, i) => hotp(secret, i))).toEqual(['755224', '287082', '359152']);
    expect(totp(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000 + 30_000)).toBe(1);
    expect(verifyTotp(secret, '287082', 59_000 + 90_000)).toBeNull();
  });

  it('asks for the code at login and accepts backup codes once', async () => {
    const setup = (await t.api.post('/api/me/2fa/setup')).data;
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect(setup.uri).toContain('otpauth://totp/');
    expect((await t.api.post('/api/me/2fa/enable', { code: '000000' })).status).toBe(400);
    const first = totp(setup.secret);
    const on = (await t.api.post('/api/me/2fa/enable', { code: first })).data;
    expect(on.backup_codes).toHaveLength(8);
    expect((await t.api.get('/api/users')).data.find((u: any) => u.email === 'chef@example.com').totp_enabled).toBe(true);
    const cookie = t.api.cookie;

    t.api.clearCookie();
    const step1 = await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect(step1.data).toEqual({ needs_code: true });
    expect((await t.api.get('/api/me')).status).toBe(401);
    // The code used to switch 2FA on can't be replayed.
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123', code: first })).status).toBe(401);
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123', code: on.backup_codes[0] })).status).toBe(200);
    expect((await t.api.get('/api/me')).status).toBe(200);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123', code: on.backup_codes[0] })).status).toBe(401);
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123', code: on.backup_codes[1] });
    expect((await t.api.get('/api/me/2fa')).data).toEqual({ enabled: true, backup_left: 6 });
    expect((await t.api.post('/api/me/2fa/disable', { password: 'falsch', code: on.backup_codes[2] })).status).toBe(401);
    expect((await t.api.post('/api/me/2fa/disable', { password: 'geheim123', code: on.backup_codes[2] })).status).toBe(200);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).data.user).toBeTruthy();
    expect(cookie).toBeTruthy();
  });
});

describe('contracts with e-signature', () => {
  it('freezes the text on send, signs once with audit trail and starts workflows', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'unterschrift@kunde.de', first_name: 'Uwe', last_name: 'Unger', company: 'Unger GmbH' })).data;
    const tpl = (await t.api.post('/api/contracts', { kind: 'template', title: 'Website-Vertrag {{contact.company}}', content: '# Vertrag\n\nZwischen {{location.name}} und **{{contact.full_name}}**.\n\n- Website\n- Hosting' })).data;
    expect((await t.api.get('/api/contracts?kind=template')).data).toHaveLength(1);
    const k = (await t.api.post('/api/contracts', { template_id: tpl.id, contact_id: c.id })).data;
    expect(k.status).toBe('draft');
    expect((await t.api.raw(new URL(k.url).pathname)).status).toBe(404);

    const wf = (await t.api.post('/api/workflows', { name: 'Unterschrieben', trigger: { type: 'contract.signed', config: {} }, steps: [{ type: 'add_tag', tags: ['kunde-aktiv'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });

    const sent = (await t.api.post(`/api/contracts/${k.id}/send`, {})).data;
    expect(sent.status).toBe('sent');
    expect(sent.title).toBe('Website-Vertrag Unger GmbH');
    expect(sent.content).toContain('**Uwe Unger**');
    expect((await t.api.patch(`/api/contracts/${k.id}`, { content: 'anders' })).status).toBe(400);
    const msgs = (await t.api.get(`/api/contacts/${c.id}/messages`)).data;
    expect(msgs.some((m: any) => m.body.includes(new URL(k.url).pathname))).toBe(true);

    const path = new URL(k.url).pathname;
    const page = await (await t.api.raw(path)).text();
    expect(page).toContain('<strong>Uwe Unger</strong>');
    expect(page).toContain('<li>Website</li>');
    expect((await t.api.get(`/api/contracts/${k.id}`)).data.status).toBe('viewed');

    const sign = (body: any) => t.api.raw(`/api/public/contracts/${path.split('/').pop()}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect((await sign({ name: 'Uwe Unger', signature: png })).status).toBe(400);
    expect((await sign({ name: 'Uwe Unger', agree: true, signature: 'data:text/html;base64,PGI+' })).status).toBe(400);
    expect((await sign({ name: 'Uwe Unger', agree: true, signature: png })).status).toBe(200);
    expect((await sign({ name: 'Uwe Unger', agree: true, signature: png })).status).toBe(409);

    const done = (await t.api.get(`/api/contracts/${k.id}`)).data;
    expect(done).toMatchObject({ status: 'signed', signer_name: 'Uwe Unger', signer_email: 'unterschrift@kunde.de' });
    expect(done.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(done.audit).toContain('SHA-256');
    expect(await (await t.api.raw(path)).text()).toContain('Als PDF speichern');
    expect((await t.api.del(`/api/contracts/${k.id}`)).status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.tags).toContain('kunde-aktiv');
  });
});
