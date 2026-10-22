import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import {
  RateLimiter,
  cleanApiFailure,
  cleanDiagnostics,
  cleanUrl,
  fingerprint,
  normalizeMessage,
  parseScreenshot,
  publicStatus,
  redact,
  stageFromInput,
  topFrame,
} from '../server/services/feedback.js';
import { requiredPermission } from '../server/core/permissions.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let adminId = '';
let homeLoc = '';
let kundeLoc = '';
const mails: { to: string; subject: string; text: string }[] = [];
const settle = () => t.app.events.flush();

// 1×1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function login(email: string, password: string) {
  t.api.clearCookie();
  const r = await t.api.post('/api/auth/login', { email, password });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
}
const asAdmin = () => login('chef@example.com', 'geheim123');
const asMia = () => login('mia@kunde.de', 'mia12345');
const asLisa = () => login('lisa@andere.de', 'lisa12345');

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  adminId = me.user.id;
  homeLoc = t.api.location;
  t.app.services.feedbackMailer = async (_loc: any, m: any) => {
    mails.push(m);
    return { status: 'logged' };
  };
  kundeLoc = (await t.api.post('/api/locations', { name: 'Bäckerei Mia' })).data.id;
  const other = (await t.api.post('/api/locations', { name: 'Lisas Laden' })).data.id;
  expect((await t.api.post('/api/users', { email: 'mia@kunde.de', name: 'Mia Kunde', password: 'mia12345', role: 'member', locations: [kundeLoc], permissions: ['contacts'] })).status).toBe(200);
  expect((await t.api.post('/api/users', { email: 'lisa@andere.de', name: 'Lisa Andere', password: 'lisa12345', role: 'member', locations: [other] })).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('diagnostics, fingerprints and limits (pure)', () => {
  it('takes secrets, emails and card numbers out of free text and URLs', () => {
    const s = redact('Fehler bei anna@firma.de mit Bearer abc.def.ghi und token=sk_live_123456789 und ghm_AbCdEfGhIjKlMnOp sowie 4111 1111 1111 1111');
    expect(s).not.toContain('anna@firma.de');
    expect(s).not.toContain('abc.def.ghi');
    expect(s).not.toContain('sk_live_123456789');
    expect(s).not.toContain('ghm_AbCd');
    expect(s).not.toContain('4111');
    expect(s).toContain('[E-Mail]');
    expect(cleanUrl('https://crm.example.com/app/contacts?token=geheim&tab=2#access_token=x')).toBe('https://crm.example.com/app/contacts?token=…&tab=2');
    expect(cleanUrl('/app/settings?key=abc&q=test')).toBe('/app/settings?key=…&q=test');
    expect(redact('ab '.repeat(2000), 100).length).toBe(100);
    expect(redact('x'.repeat(60))).toBe('[entfernt]');
  });

  it('whitelists diagnostics and never keeps request bodies', () => {
    const d = cleanDiagnostics({
      url: 'https://x.de/app?password=1',
      viewport: '1280x800',
      user_agent: 'Mozilla/5.0',
      cookie: 'pghl_session=geheim',
      body: { password: 'x' },
      errors: Array.from({ length: 30 }, (_, i) => ({ message: `Fehler ${i} für max@muster.de`, stack: 'at f (app.js:1:2)', line: 1, col: 2 })),
      api_errors: [{ method: 'POST', path: '/api/contacts?apiKey=123', status: 500, error: 'Interner Fehler', body: '{"password":"geheim"}', request: { password: 'x' } }],
      device: { model: 'Pixel 9', android: '15', sdk: 35, app_version: '1.0.1', imei: '123' },
    });
    expect(d.url).toBe('https://x.de/app?password=…');
    expect((d as any).cookie).toBeUndefined();
    expect((d as any).body).toBeUndefined();
    expect(d.errors).toHaveLength(20);
    expect(JSON.stringify(d.errors)).not.toContain('max@muster.de');
    expect(d.api_errors![0]).toEqual({ method: 'POST', path: '/api/contacts?apiKey=…', status: 500, error: 'Interner Fehler', at: '' });
    expect(JSON.stringify(d)).not.toContain('geheim');
    expect(d.device).toEqual({ model: 'Pixel 9', android: '15', sdk: 35, app_version: '1.0.1' });
    expect(cleanApiFailure({ method: 'evil', path: '/x', status: 'abc' })).toMatchObject({ method: 'GET', status: 0 });
    expect(cleanDiagnostics('quatsch')).toEqual({});
  });

  it('groups the same error regardless of ids, numbers and build hashes', () => {
    const a = fingerprint('client', "Cannot read properties of undefined (reading 'name') at contact 12345", 'TypeError\n    at ContactCard (https://crm.example.com/assets/index-B2xk3mQ9.js:12:345)');
    const b = fingerprint('client', "Cannot read properties of undefined (reading 'name') at contact 999", 'TypeError\n    at ContactCard (https://crm.example.com/assets/index-Zz9Yy8Xx.js:99:1)');
    const c = fingerprint('client', "Cannot read properties of undefined (reading 'name') at contact 999", 'TypeError\n    at DealCard (https://crm.example.com/assets/index-Zz9Yy8Xx.js:99:1)');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(fingerprint('server', 'x', '')).not.toBe(fingerprint('client', 'x', ''));
    expect(topFrame('Error: x\n    at Object.handler (/srv/dist-server/server/modules/contacts.js:10:5)')).toBe('handler@contacts.js');
    expect(topFrame('render@https://x.de/assets/index-abcdef12.js:1:2')).toBe('render@index.js');
    expect(topFrame('java.lang.NullPointerException\n\tat org.gohigh.android.widget.Kit.render(Kit.kt:42)')).toBe('Kit.render@Kit.kt');
    expect(normalizeMessage('Kontakt "Müller" 42 fehlt')).toBe('Kontakt "…" 0 fehlt');
  });

  it('accepts only small PNG/JPEG/WebP screenshots whose bytes match', () => {
    expect(parseScreenshot(PNG).mime).toBe('image/png');
    expect(() => parseScreenshot('data:image/svg+xml;base64,PHN2Zz4=')).toThrow(/PNG, JPG oder WebP/);
    expect(() => parseScreenshot(`data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`)).toThrow(/passt nicht/);
    const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3 * 1024 * 1024 + 10)]).toString('base64')}`;
    expect(() => parseScreenshot(big)).toThrow(/größer als 3 MB/);
    expect(() => parseScreenshot('kein bild')).toThrow();
  });

  it('maps stages to public status names and back', () => {
    expect(publicStatus('bug', 'in_arbeit', 'open').label).toBe('In Arbeit');
    expect(publicStatus('wish', 'bestaetigt', 'open')).toMatchObject({ board: 'planned', label: 'Geplant' });
    expect(publicStatus('wish', 'ausgeliefert', 'closed')).toMatchObject({ board: 'done', label: 'Fertig', done: true });
    expect(publicStatus('bug', 'whatever', 'resolved').key).toBe('behoben');
    expect(stageFromInput('Geplant')).toBe('bestaetigt');
    expect(stageFromInput('declined')).toBe('abgelehnt');
    expect(stageFromInput('Ausgeliefert')).toBe('ausgeliefert');
    expect(stageFromInput('quatsch')).toBeUndefined();
  });

  it('rate limiter counts per key in a sliding window', () => {
    const r = new RateLimiter(2, 1000);
    expect(r.take('a', 0)).toBe(true);
    expect(r.take('a', 10)).toBe(true);
    expect(r.take('a', 20)).toBe(false);
    expect(r.take('b', 20)).toBe(true);
    expect(r.take('a', 1500)).toBe(true);
  });

  it('feedback routes are open to every login (not tied to a permission area)', () => {
    expect(requiredPermission('POST', '/api/feedback/reports')).toBeUndefined();
    expect(requiredPermission('GET', '/api/feedback/wishes')).toBeUndefined();
  });
});

let adminReport: any;
let miaReport: any;
let supportLoc = '';

describe('reporting a bug', () => {
  it('an admin report creates the support sub-account, the pipeline and a ticket', async () => {
    await asAdmin();
    const r = await t.api.post('/api/feedback/reports', {
      category: 'bug',
      what: 'Speichern im Kontakt dreht sich endlos',
      expected: 'Kontakt wird gespeichert',
      steps: '1. Kontakt öffnen\n2. Speichern',
      severity: 'hoch',
      location_id: homeLoc,
      screenshot: PNG,
      diagnostics: { url: 'https://crm.example.com/app/contacts/1?token=abc', route: '/app/contacts/1', viewport: '1440x900', errors: [{ message: 'TypeError: x is undefined', stack: 'at save (index-abc12345.js:1:1)' }], api_errors: [{ method: 'PUT', path: '/api/contacts/1', status: 500, error: 'Interner Fehler' }] },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    adminReport = r.data;
    expect(r.data.number).toBeGreaterThan(0);
    expect(r.data.status).toMatchObject({ key: 'neu', label: 'Neu' });
    const s = (await t.api.get('/api/feedback/settings')).data;
    supportLoc = s.support_location_id;
    expect(s.support_location_name).toBe('HyperLevel Support');
    expect(s.pipeline_id).toBeTruthy();
    expect(s.view_id).toBeTruthy();
    // The ticket lives in the support sub-account, pipeline „Fehler & Wünsche“, with SLA and contact.
    const tickets = (await t.api.get(`/api/tickets?pipeline_id=${s.pipeline_id}`, { 'x-location-id': supportLoc })).data;
    expect(tickets.total).toBe(1);
    const tk = tickets.tickets[0];
    expect(tk).toMatchObject({ category: 'Fehler', priority: 'hoch', source: 'App', status: 'Neu', contact_email: 'chef@example.com' });
    expect(tk.tags).toContain('fehlermeldung');
    expect(tk.first_response_due_at).toBeTruthy();
    expect(tk.description).toContain('Erwartet:');
    expect(tk.description).toContain('Agentur-Admin');
    const meta = (await t.api.get('/api/tickets/meta', { 'x-location-id': supportLoc })).data;
    expect(meta.pipelines.map((p: any) => p.name)).toEqual(['Support', 'Fehler & Wünsche']);
    expect(meta.pipelines[1].stages.map((x: any) => x.name)).toEqual(['Neu', 'Bestätigt', 'In Arbeit', 'Behoben', 'Ausgeliefert', 'Abgelehnt', 'Duplikat']);
    expect(meta.categories).toEqual(expect.arrayContaining(['Fehler', 'Verbesserungswunsch', 'Frage']));
    const views = (await t.api.get('/api/helpdesk/views', { 'x-location-id': supportLoc })).data;
    expect(views.map((v: any) => v.name)).toContain('Fehler & Wünsche');
  });

  it('keeps sanitised diagnostics and the screenshot for the triage panel', async () => {
    const d = (await t.api.get(`/api/feedback/admin/items/${adminReport.id}`)).data;
    expect(d.diagnostics.url).toBe('https://crm.example.com/app/contacts/1?token=…');
    expect(d.diagnostics.role).toBe('Agentur-Admin');
    expect(d.diagnostics.location_name).toBe('Testfirma');
    expect(d.diagnostics.server_version).toBeTruthy();
    expect(d.diagnostics.api_errors[0]).toMatchObject({ status: 500, path: '/api/contacts/1' });
    expect(d.files).toHaveLength(1);
    const img = await t.api.raw(d.files[0].url, { headers: { cookie: t.api.cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(d.reporter).toMatchObject({ name: 'Chef', role: 'Agentur-Admin' });
    // By ticket id (the panel in Tickets).
    expect((await t.api.get(`/api/feedback/admin/by-ticket/${d.ticket.id}`)).data.item.id).toBe(adminReport.id);
  });

  it('a client login reports too – but never gets into the support sub-account', async () => {
    await asMia();
    const r = await t.api.post('/api/feedback/reports', { category: 'Fehler', what: 'Kontaktliste lädt nicht', severity: 'kritisch', location_id: kundeLoc, diagnostics: { route: '/app/contacts' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    miaReport = r.data;
    // Not allowed: the support sub-account and an origin he has no access to.
    expect((await t.api.get('/api/tickets', { 'x-location-id': supportLoc })).status).toBe(403);
    expect((await t.api.get('/api/me')).data.locations.map((l: any) => l.id)).toEqual([kundeLoc]);
    expect((await t.api.get('/api/feedback/settings')).status).toBe(403);
    expect((await t.api.get(`/api/feedback/admin/items/${miaReport.id}`)).status).toBe(403);
    const sneaky = await t.api.post('/api/feedback/reports', { category: 'bug', what: 'Test', location_id: homeLoc });
    expect(sneaky.status).toBe(200);
    await asAdmin();
    const d = (await t.api.get(`/api/feedback/admin/items/${sneaky.data.id}`)).data;
    expect(d.diagnostics.location_id).toBeUndefined();
    const p = (await t.api.get(`/api/feedback/admin/items/${miaReport.id}`)).data;
    expect(p.diagnostics).toMatchObject({ role: 'Kunden-Login (eingeschränkt)', location_name: 'Bäckerei Mia' });
    expect(p.ticket.priority).toBe('dringend');
  });

  it('everyone only sees their own reports', async () => {
    await asMia();
    const mine = (await t.api.get('/api/feedback/reports')).data;
    expect(mine.map((r: any) => r.id)).toContain(miaReport.id);
    expect(mine.map((r: any) => r.id)).not.toContain(adminReport.id);
    expect((await t.api.get(`/api/feedback/reports/${adminReport.id}`)).status).toBe(404);
    const adminFile = (await t.app.db.get('SELECT id FROM feedback_files WHERE feedback_id = ?', adminReport.id))!.id;
    expect((await t.api.get(`/api/feedback/files/${adminFile}`)).status).toBe(404);
    await asLisa();
    expect((await t.api.get('/api/feedback/reports')).data).toEqual([]);
    expect((await t.api.get(`/api/feedback/reports/${miaReport.id}`)).status).toBe(404);
    expect((await t.api.post(`/api/feedback/reports/${miaReport.id}/messages`, { body: 'hallo' })).status).toBe(404);
  });

  it('validates input and limits screenshots', async () => {
    await asMia();
    expect((await t.api.post('/api/feedback/reports', { category: 'bug', what: '' })).status).toBe(400);
    const svg = await t.api.post('/api/feedback/reports', { category: 'bug', what: 'Bild', screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(svg.status).toBe(400);
    expect(svg.data.error).toContain('PNG, JPG oder WebP');
  });
});

describe('status changes and replies', () => {
  it('status changes in Tickets notify the reporter in the app, by push and email', async () => {
    await asAdmin();
    mails.length = 0;
    const ticketId = (await t.api.get(`/api/feedback/admin/items/${miaReport.id}`)).data.ticket.id;
    t.api.setLocation(supportLoc);
    expect((await t.api.patch(`/api/tickets/${ticketId}`, { status: 'bestaetigt' })).status).toBe(200);
    // internal note: never visible to the reporter
    await t.api.post(`/api/tickets/${ticketId}/notes`, { body: 'Intern: liegt am Index' });
    t.api.setLocation(homeLoc);
    await settle();
    expect(mails.some((m) => m.to === 'mia@kunde.de' && m.subject.includes('Bestätigt'))).toBe(true);
    const miaId = t.app.db.get('SELECT id FROM users WHERE email = ?', 'mia@kunde.de')!.id;
    expect(t.app.db.get('SELECT title FROM push_log WHERE user_id = ? AND kind = ? ORDER BY created_at DESC', miaId, 'feedback')?.title).toContain('Bestätigt');
    await asMia();
    const me = (await t.api.get('/api/feedback/me')).data;
    expect(me.unread).toBeGreaterThan(0);
    const list = (await t.api.get('/api/feedback/reports')).data;
    expect(list.find((r: any) => r.id === miaReport.id)).toMatchObject({ unread: true, status: { label: 'Bestätigt' } });
    const d = (await t.api.get(`/api/feedback/reports/${miaReport.id}`)).data;
    expect(d.thread.map((e: any) => e.type)).toContain('status');
    expect(JSON.stringify(d)).not.toContain('Intern: liegt am Index');
    expect((await t.api.get('/api/feedback/reports')).data.find((r: any) => r.id === miaReport.id).unread).toBe(false);
  });

  it('team replies from the ticket view show up under „Meine Meldungen“', async () => {
    await asAdmin();
    mails.length = 0;
    const ticketId = (await t.api.get(`/api/feedback/admin/items/${miaReport.id}`)).data.ticket.id;
    const r = await t.api.post(`/api/tickets/${ticketId}/reply`, { body: 'Danke, wir schauen es uns an.', channel: 'email' }, { 'x-location-id': supportLoc });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await settle();
    // The ticket reply itself went out by email to the contact – no second email.
    expect(mails.filter((m) => m.to === 'mia@kunde.de')).toHaveLength(0);
    await asMia();
    const d = (await t.api.get(`/api/feedback/reports/${miaReport.id}`)).data;
    expect(d.thread.find((e: any) => e.type === 'team')).toMatchObject({ body: 'Danke, wir schauen es uns an.', author: 'Team' });
    expect((await t.api.get('/api/feedback/notifications')).data.notifications[0].title).toContain('Antwort auf deine Meldung');
  });

  it('the reporter adds information; it lands on the ticket timeline', async () => {
    await asMia();
    const r = await t.api.post(`/api/feedback/reports/${miaReport.id}/messages`, { body: 'Passiert nur bei über 500 Kontakten', screenshot: PNG });
    expect(r.status).toBe(200);
    expect(r.data.thread.at(-1)).toMatchObject({ type: 'user', author: 'Du' });
    expect(r.data.files).toHaveLength(1);
    await asAdmin();
    const ticketId = (await t.api.get(`/api/feedback/admin/items/${miaReport.id}`)).data.ticket.id;
    const tl = (await t.api.get(`/api/tickets/${ticketId}`, { 'x-location-id': supportLoc })).data.timeline;
    expect(tl.some((e: any) => e.type === 'customer_reply' && e.body.includes('500 Kontakten') && e.data.user_name === 'Mia Kunde')).toBe(true);
  });

  it('„Behoben in Version …“ notifies everyone linked and fills „Was ist neu“; reopening works', async () => {
    await asAdmin();
    mails.length = 0;
    const r = await t.api.post(`/api/feedback/admin/items/${miaReport.id}/fixed`, { version: '2.4.1', note: 'Große Kontaktlisten laden wieder schnell.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.status.key).toBe('ausgeliefert');
    await settle();
    expect(mails.some((m) => m.to === 'mia@kunde.de' && m.subject.includes('Behoben in Version 2.4.1'))).toBe(true);
    await asMia();
    const log = (await t.api.get('/api/feedback/changelog')).data;
    expect(log.entries[0]).toMatchObject({ version: '2.4.1', title: 'Große Kontaktlisten laden wieder schnell.' });
    expect(log.new_count).toBe(1);
    await t.api.post('/api/feedback/changelog/seen');
    expect((await t.api.get('/api/feedback/me')).data.changelog_new).toBe(0);
    const d = (await t.api.get(`/api/feedback/reports/${miaReport.id}`)).data;
    expect(d.report).toMatchObject({ version: '2.4.1', note: 'Große Kontaktlisten laden wieder schnell.' });
    expect(d.can_reopen).toBe(true);
    const re = await t.api.post(`/api/feedback/reports/${miaReport.id}/reopen`, { reason: 'Tritt wieder auf' });
    expect(re.status, JSON.stringify(re.data)).toBe(200);
    expect(re.data.report.status.key).toBe('neu');
    await settle();
    // His own reopening does not notify him.
    expect((await t.api.get('/api/feedback/notifications')).data.notifications.filter((n: any) => n.read_at === null && n.title.includes(': Neu'))).toHaveLength(0);
  });

  it('„Als Duplikat von …“ moves the reporters to the original', async () => {
    await asLisa();
    const dup = (await t.api.post('/api/feedback/reports', { category: 'bug', what: 'Kontakte laden ewig' })).data;
    await asAdmin();
    const r = await t.api.post(`/api/feedback/admin/items/${dup.id}/duplicate`, { of: `#${miaReport.number}` });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.reporters.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Mia Kunde', 'Lisa Andere']));
    expect(r.data.duplicates[0].id).toBe(dup.id);
    await settle();
    await asLisa();
    const d = (await t.api.get(`/api/feedback/reports/${dup.id}`)).data;
    expect(d.report.status.key).toBe('duplikat');
    expect(d.report.duplicate_of.id).toBe(miaReport.id);
    expect((await t.api.get('/api/feedback/notifications')).data.notifications[0].title).toContain('zusammengeführt');
    // Fixing the original now tells Lisa as well.
    await asAdmin();
    mails.length = 0;
    await t.api.patch(`/api/feedback/admin/items/${miaReport.id}`, { fixed_in: '2.4.2', status: 'behoben' });
    await settle();
    expect(mails.map((m) => m.to).sort()).toEqual(['lisa@andere.de', 'mia@kunde.de']);
  });
});

describe('wish list', () => {
  let wish: any;
  let wish2: any;
  it('everyone submits, sees and votes – names stay hidden from other users', async () => {
    await asMia();
    const r = await t.api.post('/api/feedback/wishes', { title: 'Dunkelmodus für Rechnungen', body: 'Rechnungs-PDF auch dunkel', area: 'Umsatz', location_id: kundeLoc });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    wish = r.data.wish;
    expect(wish).toMatchObject({ votes: 1, my_vote: true, mine: true, author: 'Du', status: { board: 'idea', label: 'Idee' } });
    await asLisa();
    wish2 = (await t.api.post('/api/feedback/wishes', { title: 'WhatsApp-Vorlagen', body: 'Vorlagen direkt im Chat', area: 'Marketing' })).data.wish;
    const list = (await t.api.get('/api/feedback/wishes')).data;
    const seen = list.find((w: any) => w.id === wish.id);
    expect(seen).toMatchObject({ author: '', origin: '', mine: false, my_vote: false });
    expect(JSON.stringify(list)).not.toContain('Mia');
    expect(JSON.stringify(list)).not.toContain('Bäckerei');
    expect((await t.api.post(`/api/feedback/wishes/${wish.id}/vote`)).data).toMatchObject({ votes: 2, my_vote: true });
    expect((await t.api.post(`/api/feedback/wishes/${wish.id}/vote`)).data.votes).toBe(2);
    expect((await t.api.del(`/api/feedback/wishes/${wish.id}/vote`)).data).toMatchObject({ votes: 1, my_vote: false });
    await t.api.post(`/api/feedback/wishes/${wish.id}/vote`);
    const sorted = (await t.api.get('/api/feedback/wishes?sort=votes')).data;
    expect(sorted[0].id).toBe(wish.id);
    expect((await t.api.get('/api/feedback/wishes?sort=new')).data[0].id).toBe(wish2.id);
    expect((await t.api.get('/api/feedback/wishes?area=Marketing')).data.map((w: any) => w.id)).toEqual([wish2.id]);
    expect((await t.api.get('/api/feedback/wishes?q=dunkel')).data.map((w: any) => w.id)).toEqual([wish.id]);
    const c = await t.api.post(`/api/feedback/wishes/${wish.id}/comments`, { body: 'Ja bitte, auch für Angebote!' });
    expect(c.data.thread.at(-1)).toMatchObject({ author: 'Du', body: 'Ja bitte, auch für Angebote!' });
    await asAdmin();
    const asAgency = (await t.api.get('/api/feedback/wishes')).data.find((w: any) => w.id === wish.id);
    expect(asAgency).toMatchObject({ author: 'Mia Kunde', origin: 'Bäckerei Mia' });
    const detail = (await t.api.get(`/api/feedback/wishes/${wish.id}`)).data;
    expect(detail.thread.at(-1).author).toBe('Lisa Andere');
    await asMia();
    expect((await t.api.get(`/api/feedback/wishes/${wish.id}`)).data.thread.at(-1).author).toBe('Nutzer');
    await settle();
    expect((await t.api.get('/api/feedback/notifications')).data.notifications.some((n: any) => n.title.includes('Neuer Kommentar'))).toBe(true);
  });

  it('a wish ticket has no resolution deadline and the board follows the stage', async () => {
    await asAdmin();
    const d = (await t.api.get(`/api/feedback/admin/items/${wish.id}`)).data;
    const tk = (await t.api.get(`/api/tickets/${d.ticket.id}`, { 'x-location-id': supportLoc })).data.ticket;
    expect(tk.resolution_due_at).toBeNull();
    expect(tk.category).toBe('Verbesserungswunsch');
    expect(d.votes).toBe(2);
    expect(d.voters).toEqual(['Mia Kunde', 'Lisa Andere']);
  });

  it('status changes and shipping notify author and voters; duplicates take their votes along', async () => {
    await asAdmin();
    mails.length = 0;
    await t.api.patch(`/api/feedback/admin/items/${wish.id}`, { status: 'planned' });
    await settle();
    expect(mails.map((m) => m.to).sort()).toEqual(['lisa@andere.de', 'mia@kunde.de']);
    expect(mails[0].subject).toContain('Geplant');
    // Duplicate: Lisa's wish (her vote) moves into Mia's; Lisa already voted there – no double vote.
    const d = await t.api.post(`/api/feedback/admin/items/${wish2.id}/duplicate`, { of: wish.id });
    expect(d.data.votes).toBe(2);
    await asLisa();
    expect((await t.api.get('/api/feedback/wishes')).data.map((w: any) => w.id)).not.toContain(wish2.id);
    expect((await t.api.get(`/api/feedback/wishes/${wish2.id}`)).data.duplicate_of.id).toBe(wish.id);
    await asAdmin();
    mails.length = 0;
    const shipped = await t.api.patch(`/api/feedback/admin/items/${wish.id}`, { shipped_in: '2.5.0', changelog: 'Rechnungen gibt es jetzt auch dunkel.' });
    expect(shipped.data.status).toMatchObject({ board: 'done', label: 'Fertig' });
    await settle();
    expect(mails.map((m) => m.to).sort()).toEqual(['lisa@andere.de', 'mia@kunde.de']);
    await asLisa();
    const log = (await t.api.get('/api/feedback/changelog')).data.entries;
    expect(log.find((e: any) => e.version === '2.5.0')).toMatchObject({ kind: 'wish', title: 'Dunkelmodus für Rechnungen' });
    // Bug titles stay private in the changelog: no line → no title.
    expect(log.filter((e: any) => e.kind === 'bug').every((e: any) => e.title === null || e.title === 'Große Kontaktlisten laden wieder schnell.')).toBe(true);
  });

  it('declined wishes carry the reason; hidden ones disappear for users', async () => {
    await asMia();
    const w = (await t.api.post('/api/feedback/wishes', { title: 'Alles kostenlos', body: '!', area: 'App' })).data.wish;
    await asAdmin();
    await t.api.patch(`/api/feedback/admin/items/${w.id}`, { status: 'declined', reason: 'Passt nicht zum Produkt.' });
    await settle();
    await asMia();
    const seen = (await t.api.get('/api/feedback/wishes')).data.find((x: any) => x.id === w.id);
    expect(seen).toMatchObject({ status: { board: 'declined' }, reason: 'Passt nicht zum Produkt.' });
    await asAdmin();
    await t.api.patch(`/api/feedback/admin/items/${w.id}`, { hidden: true });
    await asMia();
    expect((await t.api.get('/api/feedback/wishes')).data.map((x: any) => x.id)).not.toContain(w.id);
    expect((await t.api.get(`/api/feedback/wishes/${w.id}`)).status).toBe(404);
  });
});

describe('automatic error capture', () => {
  it('groups browser errors into one ticket per fingerprint (opt-in; on by default for admins)', async () => {
    t.app.services.feedbackCaptureReset();
    await asMia();
    const off = (await t.api.post('/api/feedback/client-errors', { errors: [{ message: 'TypeError: x is undefined', stack: 'at a (index-abc12345.js:1:1)' }] })).data;
    expect(off.skipped).toBe('off');
    await asAdmin();
    expect((await t.api.get('/api/feedback/me')).data.prefs.auto_capture).toBe(true);
    const e = (n: number) => ({ message: `TypeError: Cannot read properties of undefined (reading 'id') for deal ${n}`, stack: `TypeError\n    at DealCard (https://crm.example.com/assets/index-Ab12Cd34.js:1:${n})` });
    const first = (await t.api.post('/api/feedback/client-errors', { errors: [e(1)], diagnostics: { route: '/app/opportunities' }, location_id: homeLoc })).data;
    expect(first.results[0].created).toBe(true);
    const again = (await t.api.post('/api/feedback/client-errors', { errors: [e(2), e(3), { message: 'Script error.' }, { message: 'x', source: 'chrome-extension://abc/x.js' }] })).data;
    expect(again.results.map((r: any) => r.created ?? r.skipped)).toEqual([false, false, 'ignored', 'ignored']);
    const items = (await t.api.get('/api/feedback/admin/items?kind=auto')).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ occurrences: 3, platform: 'web' });
    const d = (await t.api.get(`/api/feedback/admin/items/${items[0].id}`)).data;
    expect(d.title).toMatch(/^\[Browser\]/);
    expect(d.locations[0]).toMatchObject({ name: 'Testfirma' });
    expect(d.diagnostics.samples.length).toBe(3);
    expect(d.ticket).toBeTruthy();
    // Opting in as a client login works too.
    await asMia();
    await t.api.put('/api/feedback/prefs', { auto_capture: true });
    expect((await t.api.post('/api/feedback/client-errors', { errors: [e(4)] })).data.results[0].created).toBe(false);
  });

  it('rate-limits per user and caps new error tickets per hour', async () => {
    t.app.services.feedbackCaptureReset();
    await asAdmin();
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const r = await t.api.post('/api/feedback/client-errors', { errors: [{ message: `RangeError: Flood ${'abcdefghijklmnopqrstuvwxy'[i]}`, stack: `at f${i} (x.js:1:1)` }] });
      last = r.status;
      if (r.status === 429) break;
    }
    expect(last).toBe(429);
    t.app.services.feedbackCaptureReset();
    const before = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback_items WHERE kind = 'auto'`)!.n;
    let dropped = 0;
    for (let i = 0; i < 40; i++) {
      const r = await t.app.services.serverError(new Error(`Boom-${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn'[i]}`), { method: 'GET', path: `/api/x${i}`, locationId: '', user: undefined } as any, { pattern: `/api/x${i}` } as any);
      expect(typeof r).toBe('string');
      dropped = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback_items WHERE kind = 'auto'`)!.n - before;
    }
    expect(dropped).toBe(30);
  });

  it('server 5xx: grouped ticket with stack, route and request id – no request body', async () => {
    t.app.services.feedbackCaptureReset();
    t.app.router.post('/api/test-boom', 'user', (ctx) => {
      if (ctx.body?.password) throw new Error(`Kaputt bei Kontakt ${Math.floor(Math.random() * 1000)}`);
      return { ok: true };
    });
    await asAdmin();
    const r = await t.api.post('/api/test-boom', { password: 'super-geheim', note: 'vertraulich' });
    expect(r.status).toBe(500);
    expect(r.data.request_id).toMatch(/^\w{12}$/);
    expect(r.headers.get('x-request-id')).toBe(r.data.request_id);
    const r2 = await t.api.post('/api/test-boom', { password: 'nochmal' });
    expect(r2.status).toBe(500);
    const items = (await t.api.get('/api/feedback/admin/items?kind=auto&q=Kaputt')).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ occurrences: 2, platform: 'server', priority: 'hoch' });
    const d = (await t.api.get(`/api/feedback/admin/items/${items[0].id}`)).data;
    expect(d.title).toMatch(/^\[Server\] Error: Kaputt bei Kontakt 0|^\[Server\] Kaputt bei Kontakt 0/);
    expect(d.body).toContain(`Request-ID: ${r.data.request_id}`);
    expect(d.body).toContain('POST /api/test-boom');
    expect(d.diagnostics.stack).toContain('feedback.test');
    expect(d.diagnostics.samples.map((s: any) => s.request_id)).toEqual([r.data.request_id, r2.data.request_id]);
    expect(JSON.stringify(d)).not.toContain('super-geheim');
    expect(JSON.stringify(d)).not.toContain('vertraulich');
  });

  it('a fixed error that comes back reopens its ticket', async () => {
    await asAdmin();
    const item = (await t.api.get('/api/feedback/admin/items?kind=auto&q=Kaputt')).data[0];
    await t.api.post(`/api/feedback/admin/items/${item.id}/fixed`, { version: '2.6.0' });
    expect((await t.api.get(`/api/feedback/admin/items/${item.id}`)).data.status.key).toBe('ausgeliefert');
    await t.api.post('/api/test-boom', { password: 'x' });
    const d = (await t.api.get(`/api/feedback/admin/items/${item.id}`)).data;
    expect(d.status.key).toBe('bestaetigt');
    expect(d.notes.some((n: any) => n.body.includes('wieder auf'))).toBe(true);
  });
});

describe('MCP tools', () => {
  it('lists, reads and updates bug reports and wishes', async () => {
    await asAdmin();
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    await asMia();
    const bug = (await t.api.post('/api/feedback/reports', { category: 'bug', what: 'Kalender zeigt falsche Zeitzone', severity: 'mittel' })).data;
    const list = await call('ghl_list_bug_reports', { kind: 'bug' });
    expect(list.find((x: any) => x.id === bug.id)).toMatchObject({ kind: 'bug', status: 'Neu', number: bug.number });
    const got = await call('ghl_get_bug_report', { report: `#${bug.number}` });
    expect(got).toMatchObject({ id: bug.id, title: 'Kalender zeigt falsche Zeitzone' });
    expect(got.diagnostics.role).toBe('Kunden-Login (eingeschränkt)');
    mails.length = 0;
    const upd = await call('ghl_update_bug_report', { report: bug.id, status: 'in_arbeit', reply: 'Wir haben die Ursache gefunden.' });
    expect(upd).toMatchObject({ status: 'In Arbeit' });
    await settle();
    expect(mails.some((m) => m.to === 'mia@kunde.de' && m.subject.includes('Antwort auf deine Meldung'))).toBe(true);
    const fixed = await call('ghl_update_bug_report', { report: bug.id, fixed_in: '2.7.0', changelog: 'Kalender rechnet mit der richtigen Zeitzone.' });
    expect(fixed).toMatchObject({ status: 'Ausgeliefert', version: '2.7.0' });
    expect((await call('ghl_update_bug_report', { report: bug.id, status: 'quatsch' })).error).toContain('Unbekannter Status');
    const wishes = await call('ghl_list_wishes', { state: 'all' });
    expect(wishes.length).toBeGreaterThan(0);
    for (let i = 1; i < wishes.length; i++) expect(wishes[i - 1].votes).toBeGreaterThanOrEqual(wishes[i].votes);
    const w = wishes.find((x: any) => x.title === 'Dunkelmodus für Rechnungen');
    expect(w).toMatchObject({ board: 'done', votes: 2 });
    expect(await call('ghl_update_wish', { wish: w.id, status: 'in_progress', note: 'Teil 2: Angebote' })).toMatchObject({ board: 'in_progress' });
    // A sub-account key does not get these agency tools.
    await asAdmin();
    const locKey = (await t.api.post('/api/api-keys', { name: 'Loc' })).data.key;
    const tl = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${locKey}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await tl.json()).result.tools.map((x: any) => x.name)).not.toContain('ghl_list_bug_reports');
  });
});

describe('Android endpoints', () => {
  it('report, list, detail and wishes with the device token', async () => {
    await asMia();
    const tok = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel 9', platform: 'android', app_version: '1.0.1 (2)' })).data.token;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'x-app-version': '1.0.1' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json() };
    };
    const made = await call('POST', '/api/mobile/bug-reports', {
      category: 'bug',
      what: 'Widget zeigt keine Termine',
      severity: 'gering',
      location_id: kundeLoc,
      screen: 'Einstellungen',
      screenshot: PNG,
      device: { model: 'Pixel 9', manufacturer: 'Google', android: '15', sdk: 35, app_version: '1.0.1 (2)' },
      api_errors: [{ method: 'GET', path: '/api/mobile/appointments?location=all', status: 503, error: 'Service Unavailable', at: '2026-10-04T10:00:00Z' }],
    });
    expect(made.status, JSON.stringify(made.data)).toBe(200);
    expect(made.data).toMatchObject({ kind: 'bug', platform: 'android', status: { key: 'neu' } });
    expect((await call('GET', '/api/mobile/bug-reports')).data.map((r: any) => r.id)).toContain(made.data.id);
    const d = (await call('GET', `/api/mobile/bug-reports/${made.data.id}`)).data;
    expect(d.diagnostics).toMatchObject({ platform: 'android', device: { model: 'Pixel 9', android: '15' }, route: 'Einstellungen', app_version: '1.0.1 (2)' });
    expect(d.diagnostics.api_errors[0].status).toBe(503);
    expect(d.files).toHaveLength(1);
    expect((await call('POST', `/api/mobile/bug-reports/${made.data.id}/messages`, { body: 'Nach Neustart auch' })).data.thread.at(-1).body).toBe('Nach Neustart auch');
    const wishes = (await call('GET', '/api/mobile/wishes?sort=votes')).data;
    expect(Array.isArray(wishes)).toBe(true);
    const nw = await call('POST', '/api/mobile/wishes', { title: 'Widget für Tickets', body: 'Offene Tickets auf dem Homescreen', area: 'App' });
    expect(nw.data.wish).toMatchObject({ votes: 1, my_vote: true });
    expect((await call('DELETE', `/api/mobile/wishes/${nw.data.wish.id}/vote`)).data.votes).toBe(0);
    // App crashes (Mia opted in above) are grouped like browser errors.
    const crash = (n: number) => ({ errors: [{ message: `java.lang.IllegalStateException: Widget ${n} nicht gefunden`, stack: `java.lang.IllegalStateException\n\tat org.gohigh.android.widget.Kit.render(Kit.kt:${n})` }], diagnostics: { device: { model: 'Pixel 9', android: '15' }, app_version: '1.0.1 (2)' } });
    expect((await call('POST', '/api/mobile/client-errors', crash(1))).data.results[0].created).toBe(true);
    expect((await call('POST', '/api/mobile/client-errors', crash(2))).data.results[0].created).toBe(false);
    // The device token works only under /api/mobile.
    expect((await call('GET', '/api/feedback/reports')).status).toBe(403);
    await asAdmin();
    const ad = (await t.api.get(`/api/feedback/admin/items/${made.data.id}`)).data;
    const tk = (await t.api.get(`/api/tickets/${ad.ticket.id}`, { 'x-location-id': supportLoc })).data.ticket;
    expect(tk.tags).toContain('android');
    const appErr = (await t.api.get('/api/feedback/admin/items?kind=auto&q=Widget')).data[0];
    expect(appErr).toMatchObject({ platform: 'android', occurrences: 2 });
    expect(appErr.title).toMatch(/^\[Android\]/);
  });
});

describe('settings', () => {
  it('the agency can pick another support sub-account for new reports', async () => {
    await asAdmin();
    const r = await t.api.put('/api/feedback/settings', { support_location_id: homeLoc });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ support_location_id: homeLoc, support_location_name: 'Testfirma' });
    const made = (await t.api.post('/api/feedback/reports', { category: 'question', what: 'Wie exportiere ich Kontakte?' })).data;
    const d = (await t.api.get(`/api/feedback/admin/items/${made.id}`)).data;
    expect(d.ticket.location_id).toBe(homeLoc);
    expect(d.ticket.location_name).toBe('Testfirma');
    const meta = (await t.api.get('/api/tickets/meta')).data;
    expect(meta.pipelines.map((p: any) => p.name)).toContain('Fehler & Wünsche');
    // Older reports stay where they are and keep working.
    await asMia();
    expect((await t.api.get(`/api/feedback/reports/${miaReport.id}`)).status).toBe(200);
    await asAdmin();
    expect((await t.api.put('/api/feedback/settings', { support_location_id: 'gibtsnicht' })).status).toBe(400);
    expect((await t.api.put('/api/feedback/settings', { support_location_id: supportLoc })).data.support_location_id).toBe(supportLoc);
  });
});
