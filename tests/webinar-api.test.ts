import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { joinToken } from '../server/services/webinar-model.js';
import { WEBINAR_TOOLS } from '../server/modules/webinar-tools.js';
import { classify } from '../server/services/agent-safety.js';

/**
 * The team's side of the webinars: create / edit / publish, registrations, the video upload and its streaming, preview links,
 * member areas, sub-account isolation, the audit log, the MCP tools and the app's read endpoints. No network.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let keyA = '';
let keyB = '';
let member: Call;
let limited: Call;
const clock = { ms: Date.parse('2026-11-06T12:00:00Z') };
const SECRET = 'test-secret';

const audit = (action: string) => t.app.db.all<any>('SELECT * FROM audit_log WHERE action = ? ORDER BY at', action);
const asKey = (method: string, path: string, body?: unknown, key = keyA, location = loc) =>
  t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-location-id': location }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));
let rpcId = 0;
const mcp = async (name: string, args: any, key = keyA) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data, error: j.error };
};

const READY = { video: { type: 'url', url: 'https://cdn.example.com/w.mp4' }, duration_s: 1800, schedule: { fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, horizon_days: 14 } };
const make = async (title: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/webinars', { title, ...extra })).data;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.webinarNow = () => clock.ms;
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  keyA = (await t.api.post('/api/api-keys', { name: 'Webinar A' })).data.key;
  t.api.setLocation(other);
  keyB = (await t.api.post('/api/api-keys', { name: 'Webinar B' })).data.key;
  t.api.setLocation(loc);
  await t.api.post('/api/users', { email: 'seiten@example.com', password: 'passwort-s1', name: 'Seita', locations: [loc], permissions: ['funnels'] });
  await t.api.post('/api/users', { email: 'kontakte@example.com', password: 'passwort-k1', name: 'Konrad', locations: [loc], permissions: ['contacts'] });
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await member('POST', '/api/auth/login', { email: 'seiten@example.com', password: 'passwort-s1' })).status).toBe(200);
  limited = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await limited('POST', '/api/auth/login', { email: 'kontakte@example.com', password: 'passwort-k1' })).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('create, edit, publish', () => {
  it('starts every webinar as a draft with honest defaults and unique slugs', async () => {
    const a = await make('Mein Webinar');
    const b = await make('Mein Webinar');
    expect(a).toMatchObject({ title: 'Mein Webinar', slug: 'mein-webinar', status: 'draft', duration_s: 0, video: { type: 'none' } });
    expect(b.slug).toBe('mein-webinar-2');
    expect(a.settings.room).toMatchObject({ label: 'Automatisiertes Webinar', replay_label: 'Aufzeichnung', show_counter: false, scripted_enabled: false, questions: true });
    expect(a.settings.reminders.items.map((r: any) => [r.key, r.offset_min])).toEqual([['24h', 1440], ['1h', 60], ['15m', 15], ['start', 0]]);
    expect(a.settings.replay).toEqual({ enabled: true, hours: 48 });
    expect(a.urls.page).toBe('http://localhost/w/mein-webinar');
    expect(a.urls.embed).toContain('?embed=1');
    expect(a.problems).toHaveLength(3);
    expect(a.upcoming).toEqual([]);
    expect(audit('webinars.create').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses nonsense in German and publishing before it is ready', async () => {
    expect((await t.api.post('/api/webinars', {})).data.error).toMatch(/Titel/);
    expect((await t.api.post('/api/webinars', { title: 'X', status: 'published' })).data.error).toMatch(/als Entwurf/);
    expect((await t.api.post('/api/webinars', { title: 'X', schedule: { fixed: { enabled: true, times: ['abc'] } } })).data.error).toMatch(/HH:MM/);
    expect((await t.api.post('/api/webinars', { title: 'X', video: { type: 'url', url: 'http://unsicher.example.com/a.mp4' } })).data.error).toMatch(/https/);
    const w = await make('Noch nicht fertig');
    const early = await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
    expect(early.status).toBe(400);
    expect(early.data.error).toMatch(/Noch nicht bereit zum Veröffentlichen/);
    expect(early.data.error).toMatch(/Videoquelle/);
    expect(early.data.error).toMatch(/Dauer/);
    expect(early.data.error).toMatch(/Termin/);
    const ok = await t.api.patch(`/api/webinars/${w.id}`, { ...READY, status: 'published' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.status).toBe('published');
    expect(ok.data.upcoming[0]).toMatchObject({ start: '2026-11-09T18:00:00.000Z', kind: 'fixed', taken: 0, full: false });
    // only what was written is in the audit log (the refused attempt is not)
    expect(audit('webinars.update').length).toBeGreaterThanOrEqual(1);
  });

  it('changes settings section by section without losing the rest, and refuses anything that calls the webinar live', async () => {
    const w = await make('Einstellungen');
    const r = await t.api.patch(`/api/webinars/${w.id}`, { settings: { room: { show_counter: true }, replay: { hours: 72 } } });
    expect(r.data.settings.room).toMatchObject({ show_counter: true, label: 'Automatisiertes Webinar', questions: true });
    expect(r.data.settings.replay).toEqual({ enabled: true, hours: 72 });
    expect(r.data.settings.reminders.items).toHaveLength(4);
    const live = await t.api.patch(`/api/webinars/${w.id}`, { settings: { room: { label: 'Live-Webinar' } } });
    expect(live.status).toBe(400);
    expect(live.data.error).toMatch(/nicht als „live“ bezeichnet/);
    expect((await t.api.get(`/api/webinars/${w.id}`)).data.settings.room.label).toBe('Automatisiertes Webinar');
    // scripted messages: off by default, kept when switched on, sorted by time
    const s = await t.api.patch(`/api/webinars/${w.id}`, { duration_s: 600, settings: { room: { scripted_enabled: true, scripted: [{ at_s: 300, name: 'Team', text: 'Später' }, { at_s: 30, text: 'Früh' }] } } });
    expect(s.data.settings.room.scripted.map((m: any) => [m.at_s, m.text, m.name])).toEqual([[30, 'Früh', 'Team'], [300, 'Später', 'Team']]);
    // a moment outside the video is an error; when the video gets shorter later, moments move to its end
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { room: { scripted: [{ at_s: 9999, text: 'Zu spät' }] } } })).data.error).toMatch(/Zeitpunkt/);
    const shorter = await t.api.patch(`/api/webinars/${w.id}`, { duration_s: 200 });
    expect(shorter.data.settings.room.scripted.map((m: any) => m.at_s)).toEqual([30, 200]);
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { room: { scripted: [{ at_s: 1, text: '' }] } } })).data.error).toMatch(/Text fehlt/);
  });

  it('validates the offer: a product or form of this sub-account, an https link, a real deadline', async () => {
    const w = await make('Angebot');
    const product = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 9900 })).data;
    const ok = await t.api.patch(`/api/webinars/${w.id}`, { duration_s: 600, settings: { offer: { enabled: true, at_s: 100, title: 'Kurs', target: { type: 'product', product_id: product.id }, countdown_s: 600 } } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.settings.offer).toMatchObject({ enabled: true, at_s: 100, countdown_s: 600, target: { type: 'product', product_id: product.id } });
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { offer: { target: { type: 'product', product_id: 'gibt-es-nicht' } } } })).data.error).toMatch(/Produkt gibt es/);
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { offer: { target: { type: 'url', url: 'javascript:alert(1)' } } } })).status).toBe(400);
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { offer: { target: { type: 'form', form_id: 'nix-nix-nix' } } } })).data.error).toMatch(/Formular gibt es/);
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { offer: { target: { type: 'url', url: 'https://example.com/angebot' } } } })).status).toBe(200);
    // another sub-account's product is not "yours"
    t.api.setLocation(other);
    const foreign = (await t.api.post('/api/products', { name: 'Fremdes Produkt', price_cents: 100 })).data;
    t.api.setLocation(loc);
    expect((await t.api.patch(`/api/webinars/${w.id}`, { settings: { offer: { target: { type: 'product', product_id: foreign.id } } } })).data.error).toMatch(/Produkt gibt es/);
  });

  it('lists with numbers in one query, duplicates as a draft and deletes with everything attached', async () => {
    const w = await make('Liste', READY);
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
    await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'liste@example.com', first_name: 'Lena', session: '2026-11-09T18:00:00.000Z' });
    const list = (await t.api.get('/api/webinars')).data;
    const row = list.find((x: any) => x.id === w.id);
    expect(row).toMatchObject({ title: 'Liste', status: 'published', registrations: 1, attended: 0, upcoming_registrations: 1, next_session: '2026-11-09T18:00:00.000Z', video_type: 'url', url: `http://localhost/w/${w.slug}` });
    const copy = (await t.api.post(`/api/webinars/${w.id}/duplicate`)).data;
    expect(copy).toMatchObject({ title: 'Liste (Kopie)', status: 'draft', video: { type: 'url' } });
    expect(copy.slug).not.toBe(w.slug);
    const del = await t.api.del(`/api/webinars/${w.id}`);
    expect(del.status).toBe(200);
    expect((await t.api.get(`/api/webinars/${w.id}`)).status).toBe(404);
    expect(t.app.db.get('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', w.id)!.n).toBe(0);
    expect((await t.api.get(`/api/public/webinars/${w.slug}`)).status).toBe(404);
    expect(audit('webinars.delete')).toHaveLength(1);
  });

  it('changes the slug to a free one', async () => {
    const a = await make('Slug A');
    const b = await make('Slug B');
    const r = await t.api.patch(`/api/webinars/${b.id}`, { slug: a.slug });
    expect(r.data.slug).toBe(`${a.slug}-2`);
    expect((await t.api.patch(`/api/webinars/${b.id}`, { slug: 'Mein Neuer Name!' })).data.slug).toBe('mein-neuer-name');
    expect((await t.api.patch(`/api/webinars/${b.id}`, { slug: 'assets' })).data.slug).toBe('assets-2');
  });
});

describe('registrations by the team', () => {
  let w: any;
  beforeAll(async () => {
    w = await make('Team-Anmeldung', READY);
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published', schedule: { fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, horizon_days: 14, max_per_session: 2 } });
  });

  it('registers a contact by id or by e-mail, hands back the personal link and refuses what cannot be registered', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Karla', email: 'karla@example.com' })).data;
    const r = await t.api.post(`/api/webinars/${w.id}/registrations`, { contact_id: contact.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ contact_id: contact.id, created: true, session: { start: '2026-11-09T18:00:00.000Z', kind: 'fixed' } });
    expect(r.data.join_url).toContain(`/w/${w.slug}/watch?t=${encodeURIComponent(joinToken(SECRET, r.data.id))}`);
    const same = await t.api.post(`/api/webinars/${w.id}/registrations`, { contact_id: contact.id });
    expect(same.data).toMatchObject({ id: r.data.id, created: false });
    const byMail = await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'neu@example.com', first_name: 'Neu', silent: true });
    expect(byMail.data.created).toBe(true);
    // the team can fill seats up to the limit, then it is full for everybody
    const full = await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'dritte@example.com', first_name: 'Dritte', session: '2026-11-09T18:00:00.000Z' });
    expect(full.status).toBe(409);
    expect(full.data.error).toMatch(/ausgebucht/);
    // without a session the next free one is taken
    const next = await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'vierte@example.com', first_name: 'Vierte' });
    expect(next.data.session.start).toBe('2026-11-16T18:00:00.000Z');
    const second = await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'dritte@example.com', first_name: 'Dritte', session: '2026-11-16T18:00:00.000Z' });
    expect(second.status).toBe(200);
    expect((await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'x@example.com' })).data.error).toMatch(/Vornamen/);
    expect((await t.api.post(`/api/webinars/${w.id}/registrations`, { contact_id: 'gibt-es-nicht' })).status).toBe(404);
    const noMail = (await t.api.post('/api/contacts', { first_name: 'Ohne', phone: '+4915112345678' })).data;
    expect((await t.api.post(`/api/webinars/${w.id}/registrations`, { contact_id: noMail.id })).data.error).toMatch(/E-Mail/);
    // a draft cannot take registrations
    const draft = await make('Entwurf');
    expect((await t.api.post(`/api/webinars/${draft.id}/registrations`, { email: 'e@example.com', first_name: 'E' })).status).toBe(409);
    expect(audit('webinars.registrations.create').length).toBeGreaterThanOrEqual(3);
    // silent: no confirmation for the import
    await t.app.events.flush();
    const mails = (email: string) => t.app.db.all<any>(`SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? AND m.source = 'Webinar-Bestätigung'`, email);
    expect(mails('neu@example.com')).toHaveLength(0);
    expect(mails('karla@example.com')).toHaveLength(1);
  });

  it('lists registrations with their tracking, filters, and never exposes tokens', async () => {
    const all = (await t.api.get(`/api/webinars/${w.id}/registrations`)).data;
    expect(all.total).toBe(4);
    expect(all.registrations[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), email: expect.any(String), attended: false, watch_pct: 0, cta_clicked: false, purchased: false, status: 'registered' }));
    expect(JSON.stringify(all)).not.toMatch(/watch\?t=|\.[A-Za-z0-9_-]{22}"/);
    expect((await t.api.get(`/api/webinars/${w.id}/registrations?session=2026-11-16T18:00:00.000Z`)).data.total).toBe(2);
    expect((await t.api.get(`/api/webinars/${w.id}/registrations?q=karla`)).data.registrations.map((r: any) => r.email)).toEqual(['karla@example.com']);
    expect((await t.api.get(`/api/webinars/${w.id}/registrations?attended=1`)).data.total).toBe(0);
    expect((await t.api.get(`/api/webinars/${w.id}/registrations?limit=1`)).data.registrations).toHaveLength(1);
  });

  it('cancels a registration and says so on the timeline', async () => {
    const reg = (await t.api.get(`/api/webinars/${w.id}/registrations?q=neu@`)).data.registrations[0];
    expect((await t.api.del(`/api/webinars/${w.id}/registrations/${reg.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/webinars/${w.id}/registrations?status=cancelled`)).data.total).toBe(1);
    expect(t.app.db.all(`SELECT * FROM activities WHERE contact_id = ? AND type = 'webinar.cancelled'`, reg.contact_id)).toHaveLength(1);
    expect((await t.api.del(`/api/webinars/${w.id}/registrations/gibt-es-nicht`)).status).toBe(404);
    expect(audit('webinars.registrations.delete')).toHaveLength(1);
  });
});

describe('the video file', () => {
  const mp4 = (n: number) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(n - 12, 7)]);
  const put = (wid: string, uid: string, body: Buffer, offset: number, cookie = true) =>
    t.api.raw(`/api/webinars/${wid}/video/upload/${uid}?offset=${offset}`, { method: 'PUT', headers: { ...(cookie ? { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc } : {}), 'content-type': 'application/octet-stream' }, body }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));
  let w: any;
  let uid = '';
  const body = mp4(5000);

  it('takes the file in parts, checks the first bytes and makes the finished upload the webinar’s video', async () => {
    w = await make('Mit Upload', { duration_s: 1800, schedule: READY.schedule });
    expect((await t.api.post(`/api/webinars/${w.id}/video/upload`, { name: 'datei.exe', size: 100 })).data.error).toMatch(/Videodateien/);
    expect((await t.api.post(`/api/webinars/${w.id}/video/upload`, { name: 'v.mp4', size: 0 })).data.error).toMatch(/Dateigröße/);
    expect((await t.api.post(`/api/webinars/${w.id}/video/upload`, { name: 'v.mp4', size: 9e15 })).data.error).toMatch(/größer als/);
    const start = (await t.api.post(`/api/webinars/${w.id}/video/upload`, { name: 'Mein Video.mp4', size: body.length })).data;
    uid = start.id;
    expect(start).toMatchObject({ chunk_size: 8 * 1024 * 1024, size: 5000, received: 0 });
    // something that is not a video is refused at the first part
    expect((await put(w.id, uid, Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' ')), 0)).status).toBe(400);
    expect(t.app.db.get('SELECT COUNT(*) n FROM webinar_uploads WHERE id = ?', uid)!.n).toBe(0);
    const again = (await t.api.post(`/api/webinars/${w.id}/video/upload`, { name: 'Mein Video.mp4', size: body.length })).data;
    uid = again.id;
    expect((await put(w.id, uid, body.subarray(0, 3000), 0)).data).toMatchObject({ received: 3000, complete: false });
    // out of order, repeated and too long
    expect((await put(w.id, uid, body.subarray(4000), 4000)).status).toBe(409);
    expect((await put(w.id, uid, body.subarray(0, 3000), 0)).data).toMatchObject({ received: 3000, complete: false });
    expect((await put(w.id, uid, Buffer.alloc(3000), 3000)).status).toBe(400);
    const done = await put(w.id, uid, body.subarray(3000), 3000);
    expect(done.data).toMatchObject({ received: 5000, complete: true });
    const detail = (await t.api.get(`/api/webinars/${w.id}`)).data;
    expect(detail.video).toEqual({ type: 'upload', upload_id: uid, name: 'Mein Video.mp4' });
    expect(detail.problems).toEqual([]);
    const file = t.app.db.get<any>('SELECT * FROM webinar_uploads WHERE id = ?', uid)!;
    expect(existsSync(join(t.app.config.dataDir, 'webinars', file.file))).toBe(true);
    expect(file.file.endsWith('.mp4')).toBe(true);
    // not for other sub-accounts' webinars, not without login
    expect((await put(w.id, uid, body, 0, false)).status).toBe(401);
    expect((await asKey('PUT', `/api/webinars/${w.id}/video/upload/${uid}`, undefined, keyB, other)).status).toBe(404);
  });

  it('streams the file with byte ranges – to the running room and the recording, not to the waiting room', async () => {
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
    const reg = (await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'stream@example.com', first_name: 'Stella', session: '2026-11-09T18:00:00.000Z' })).data;
    const tok = encodeURIComponent(joinToken(SECRET, reg.id));
    const url = `/w/${w.slug}/media?t=${tok}`;
    clock.ms = Date.parse('2026-11-09T17:50:00Z');
    expect((await t.api.raw(url)).status).toBe(403);
    clock.ms = Date.parse('2026-11-09T18:05:00Z');
    const full = await t.api.raw(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await full.arrayBuffer()).equals(body)).toBe(true);
    const part = await t.api.raw(url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(Buffer.from(await part.arrayBuffer()).equals(body.subarray(100, 200))).toBe(true);
    expect((await t.api.raw(url, { headers: { range: 'bytes=9000-9999' } })).status).toBe(416);
    // after the session: the recording window
    clock.ms = Date.parse('2026-11-09T18:31:00Z');
    expect((await t.api.raw(url)).status).toBe(200);
    clock.ms = Date.parse('2026-11-12T00:00:00Z');
    expect((await t.api.raw(url)).status).toBe(403);
    // other tokens and other webinars
    expect((await t.api.raw(`/w/${w.slug}/media?t=kaputt`)).status).toBe(404);
    expect((await t.api.raw(`/w/${w.slug}/media`)).status).toBe(404);
    clock.ms = Date.parse('2026-11-06T12:00:00Z');
  });

  it('copies the file on duplicate, deletes it with the webinar and sweeps files without a row', async () => {
    const copy = (await t.api.post(`/api/webinars/${w.id}/duplicate`)).data;
    expect(copy.video.type).toBe('upload');
    expect(copy.video.upload_id).not.toBe(uid);
    const files = () => readdirSync(join(t.app.config.dataDir, 'webinars'));
    const before = files().length;
    expect(before).toBeGreaterThanOrEqual(2);
    // a video of another kind drops the file
    await t.api.patch(`/api/webinars/${copy.id}`, { video: { type: 'url', url: 'https://cdn.example.com/x.mp4' } });
    expect(files().length).toBe(before - 1);
    // an upload cannot be borrowed by another webinar
    expect((await t.api.patch(`/api/webinars/${copy.id}`, { video: { type: 'upload', upload_id: uid, name: 'x' } })).data.error).toMatch(/gehört nicht zu diesem Webinar/);
    await t.api.del(`/api/webinars/${w.id}`);
    expect(files().length).toBe(before - 2);
    // an orphan older than a day goes, a fresh one stays
    const dir = join(t.app.config.dataDir, 'webinars');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verwaist.mp4'), 'x');
    expect(t.app.services.webinars.sweep()).toBe(0);
    const old = new Date(Date.now() - 2 * 86_400_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(dir, 'verwaist.mp4'), old, old);
    expect(t.app.services.webinars.sweep()).toBe(1);
  });

  it('plays a video of the Video-Studio of this sub-account (upload) and refuses one of another', async () => {
    const dir = join(t.app.config.dataDir, 'video-studio', 'uploads');
    mkdirSync(dir, { recursive: true });
    const studio = mp4(3000);
    writeFileSync(join(dir, 'studio1.mp4'), studio);
    const row = (id: string, location: string, file: string) => t.app.db.insert('video_uploads', { id, location_id: location, name: 'Studio.mp4', file, size: 3000, received: 3000, status: 'complete', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    row('studioup1', loc, 'studio1.mp4');
    row('studioup2', other, 'studio1.mp4');
    const assets = (await t.api.get('/api/webinars/studio-assets')).data;
    expect(assets.uploads.map((u: any) => u.id)).toEqual(['studioup1']);
    expect(assets.clips).toEqual([]);
    const s = await make('Studio', { duration_s: 600, schedule: READY.schedule });
    expect((await t.api.patch(`/api/webinars/${s.id}`, { video: { type: 'studio_upload', upload_id: 'studioup2' } })).data.error).toMatch(/Video-Studio dieses Sub-Accounts/);
    expect((await t.api.patch(`/api/webinars/${s.id}`, { video: { type: 'studio_upload', upload_id: 'studioup1' } })).status).toBe(200);
    await t.api.patch(`/api/webinars/${s.id}`, { status: 'published' });
    const reg = (await t.api.post(`/api/webinars/${s.id}/registrations`, { email: 'studio@example.com', first_name: 'Studio', session: '2026-11-09T18:00:00.000Z' })).data;
    clock.ms = Date.parse('2026-11-09T18:01:00Z');
    const r = await t.api.raw(`/w/${s.slug}/media?t=${encodeURIComponent(joinToken(SECRET, reg.id))}`, { headers: { range: 'bytes=0-15' } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).equals(studio.subarray(0, 16))).toBe(true);
    // a clip: only ready clips of this sub-account
    const now = new Date().toISOString();
    t.app.db.insert('video_jobs', { id: 'job1', location_id: loc, source_type: 'url', status: 'completed', created_at: now, updated_at: now });
    t.app.db.insert('video_clips', { id: 'clipaaaa1', job_id: 'job1', location_id: loc, os_index: 0, video_path: 'out/clip.mp4', title: 'Mein Clip', duration: 42, status: 'ready', created_at: now, updated_at: now });
    expect((await t.api.get('/api/webinars/studio-assets')).data.clips).toEqual([{ id: 'clipaaaa1', title: 'Mein Clip', duration_s: 42, created_at: now }]);
    expect((await t.api.patch(`/api/webinars/${s.id}`, { video: { type: 'studio_clip', clip_id: 'clipaaaa1' } })).status).toBe(200);
    t.api.setLocation(other);
    const foreign = await make('Fremd', { duration_s: 60 });
    expect((await t.api.patch(`/api/webinars/${foreign.id}`, { video: { type: 'studio_clip', clip_id: 'clipaaaa1' } })).data.error).toMatch(/Clip gibt es/);
    t.api.setLocation(loc);
    clock.ms = Date.parse('2026-11-06T12:00:00Z');
  });
});

describe('the team’s preview', () => {
  it('opens the room at a chosen second without counting anything, also for drafts, and expires', async () => {
    const w = await make('Vorschau', { ...READY, video: { type: 'url', url: 'https://cdn.example.com/w.mp4' }, settings: { room: { scripted_enabled: true, scripted: [{ at_s: 60, name: 'Team', text: 'Hallo!' }] } } });
    const link = (await t.api.post(`/api/webinars/${w.id}/preview-link`, { offset_s: 120 })).data;
    expect(link.url).toContain(`/w/${w.slug}/watch?p=`);
    expect(link.offset_s).toBe(120);
    const path = new URL(link.url).pathname + new URL(link.url).search;
    const page = await t.api.raw(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    const cfg = JSON.parse(/<script type="application\/json" id="wb-cfg">(.*?)<\/script>/s.exec(html)![1]);
    expect(cfg).toMatchObject({ mode: 'preview', clock: { state: 'running', offset_s: 120 }, token: expect.any(String) });
    expect(cfg.scripted_label).toBe('Automatische Nachricht');
    expect(cfg.scripted).toEqual([{ id: expect.any(String), at_s: 60, name: 'Team', text: 'Hallo!' }]);
    expect(t.app.db.get('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', w.id)!.n).toBe(0);
    // another webinar's preview token, an expired one and nonsense are refused
    const other2 = await make('Andere Vorschau');
    expect((await t.api.raw(`/w/${other2.slug}/watch?p=${new URL(link.url).searchParams.get('p')}`)).status).toBe(404);
    expect((await t.api.raw(`/w/${w.slug}/watch?p=1.2.abc`)).status).toBe(404);
    // the offset is limited to the video
    expect((await t.api.post(`/api/webinars/${w.id}/preview-link`, { offset_s: 99999 })).data.offset_s).toBe(1799);
    // a member without the area cannot ask for one
    expect((await limited('POST', `/api/webinars/${w.id}/preview-link`, {})).status).toBe(403);
  });
});

describe('what the pages never do', () => {
  it('escape what the team wrote – in the registration page, the room and its JSON block', async () => {
    const evil = `<img src=x onerror=alert(1)></script><script>alert(2)</script>`;
    const short = '<img src=x onerror=alert(1)>';
    const w = await make(evil, { ...READY, description: evil, presenter_name: short, settings: { room: { scripted_enabled: true, scripted: [{ at_s: 1, name: short, text: evil }], waiting_text: evil }, offer: { enabled: true, title: evil, text: evil, button_text: short, target: { type: 'url', url: 'https://example.com/a' } }, registration: { headline: evil, consent_text: evil } } });
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
    const reg = await t.api.raw(`/w/${w.slug}`);
    const html = await reg.text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/<script>alert/);
    const reg2 = (await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'xss@example.com', first_name: 'X', session: '2026-11-09T18:00:00.000Z' })).data;
    const room = await (await t.api.raw(`/w/${w.slug}/watch?t=${encodeURIComponent(joinToken(SECRET, reg2.id))}`)).text();
    expect(room).not.toContain('<img src=x');
    expect(room).not.toMatch(/<script>alert/);
    // inside the JSON block the angle brackets are escaped, so nothing can close the block
    expect(room.split('<script type="application/json" id="wb-cfg">')[1].split('</script>')[0]).not.toContain('<');
  });

  it('cannot be opened with a link meant for another webinar, another sub-account or a draft', async () => {
    const a = await make('Link A', READY);
    const b = await make('Link B', READY);
    await t.api.patch(`/api/webinars/${a.id}`, { status: 'published' });
    await t.api.patch(`/api/webinars/${b.id}`, { status: 'published' });
    const reg = (await t.api.post(`/api/webinars/${a.id}/registrations`, { email: 'link@example.com', first_name: 'L', session: '2026-11-09T18:00:00.000Z' })).data;
    const tok = encodeURIComponent(joinToken(SECRET, reg.id));
    expect((await t.api.raw(`/w/${a.slug}/watch?t=${tok}`)).status).toBe(200);
    expect((await t.api.raw(`/w/${b.slug}/watch?t=${tok}`)).status).toBe(404);
    expect((await t.api.raw(`/api/public/webinars/${b.slug}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: joinToken(SECRET, reg.id) }) })).status).toBe(404);
    await t.api.patch(`/api/webinars/${a.id}`, { status: 'draft' });
    expect((await t.api.raw(`/w/${a.slug}/watch?t=${tok}`)).status).toBe(404);
  });
});

describe('member areas and sub-account isolation', () => {
  let mine: any;
  beforeAll(async () => {
    mine = await make('Rechte', READY);
    await t.api.patch(`/api/webinars/${mine.id}`, { status: 'published' });
  });

  it('opens for logins with the area "Funnels & Websites" and closes for the others', async () => {
    expect((await member('GET', '/api/webinars')).status).toBe(200);
    expect((await member('POST', '/api/webinars', { title: 'Von Seita' })).status).toBe(200);
    expect((await member('GET', `/api/webinars/${mine.id}/stats`)).status).toBe(200);
    for (const [m, p] of [['GET', '/api/webinars'], ['POST', '/api/webinars'], ['GET', `/api/webinars/${mine.id}`], ['PATCH', `/api/webinars/${mine.id}`], ['DELETE', `/api/webinars/${mine.id}`], ['GET', `/api/webinars/${mine.id}/registrations`], ['POST', `/api/webinars/${mine.id}/registrations`], ['GET', `/api/webinars/${mine.id}/stats`], ['GET', '/api/webinars/studio-assets']] as const) {
      const r = await limited(m, p, m === 'GET' ? undefined : {});
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    const anon = await t.api.raw('/api/webinars');
    expect(anon.status).toBe(401);
  });

  it('keeps each sub-account to its own webinars, registrations, stats and files', async () => {
    t.api.setLocation(other);
    const theirs = await make('Nur Zweite Firma', READY);
    t.api.setLocation(loc);
    const list = (await t.api.get('/api/webinars')).data.map((x: any) => x.title);
    expect(list).not.toContain('Nur Zweite Firma');
    for (const [m, p, b] of [
      ['GET', `/api/webinars/${theirs.id}`],
      ['PATCH', `/api/webinars/${theirs.id}`, { title: 'Gekapert' }],
      ['DELETE', `/api/webinars/${theirs.id}`],
      ['POST', `/api/webinars/${theirs.id}/duplicate`, {}],
      ['GET', `/api/webinars/${theirs.id}/sessions`],
      ['GET', `/api/webinars/${theirs.id}/registrations`],
      ['POST', `/api/webinars/${theirs.id}/registrations`, { email: 'a@example.com', first_name: 'A' }],
      ['GET', `/api/webinars/${theirs.id}/stats`],
      ['GET', `/api/webinars/${theirs.id}/questions`],
      ['POST', `/api/webinars/${theirs.id}/preview-link`, {}],
      ['POST', `/api/webinars/${theirs.id}/video/upload`, { name: 'a.mp4', size: 100 }],
    ] as [string, string, any?][]) {
      const r = await t.api[m === 'GET' ? 'get' : m === 'POST' ? 'post' : m === 'PATCH' ? 'patch' : 'del'](p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await t.api.get(`/api/webinars/${theirs.id}`)).status).toBe(404);
    t.api.setLocation(other);
    expect((await t.api.get(`/api/webinars/${theirs.id}`)).data.title).toBe('Nur Zweite Firma');
    t.api.setLocation(loc);
    // a contact of this sub-account cannot be put into the other one's webinar, and the other way round
    const c = (await t.api.post('/api/contacts', { first_name: 'Hier', email: 'hier@example.com' })).data;
    t.api.setLocation(other);
    expect((await t.api.post(`/api/webinars/${theirs.id}/registrations`, { contact_id: c.id })).status).toBe(404);
    t.api.setLocation(loc);
    // API keys are bound to their sub-account
    expect((await asKey('GET', `/api/webinars/${theirs.id}`, undefined, keyA, loc)).status).toBe(404);
    expect((await asKey('GET', `/api/webinars/${theirs.id}`, undefined, keyB, other)).status).toBe(200);
    // the header cannot move a key to another sub-account: it still asks its own
    expect((await asKey('GET', `/api/webinars/${theirs.id}`, undefined, keyA, other)).status).toBe(404);
  });
});

describe('MCP tools', () => {
  let w: any;
  beforeAll(async () => {
    w = await make('MCP-Webinar', READY);
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
  });

  it('has four tools with the right safety flags', async () => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools: any[] = ((await r.json()) as any).result.tools.filter((x: any) => x.name.startsWith('ghl_webinar_'));
    expect(tools.map((x) => x.name).sort()).toEqual(['ghl_webinar_get', 'ghl_webinar_list', 'ghl_webinar_register', 'ghl_webinar_stats']);
    for (const tool of WEBINAR_TOOLS) {
      expect(tool.description).toMatch(/nie „live“|Automatisiert/);
      expect(tool.annotations.readOnlyHint === true).toBe(tool.name !== 'ghl_webinar_register');
    }
    // the HyperLevel Agent asks before it registers somebody (a write that sends mail)
    expect(classify(WEBINAR_TOOLS.find((x) => x.name === 'ghl_webinar_register')!)).toBe('write');
    for (const n of ['ghl_webinar_list', 'ghl_webinar_get', 'ghl_webinar_stats']) expect(classify(WEBINAR_TOOLS.find((x) => x.name === n)!), n).toBe('read');
  });

  it('lists, shows, registers and reports', async () => {
    const list = await mcp('ghl_webinar_list', { location_id: loc });
    expect(list.data.webinars.find((x: any) => x.id === w.id)).toMatchObject({ title: 'MCP-Webinar', status: 'published', link: `/app/webinars/${w.id}` });
    const get = await mcp('ghl_webinar_get', { location_id: loc, webinar_id: w.id });
    expect(get.data).toMatchObject({ id: w.id, status: 'published', duration_s: 1800, registration_url: `http://localhost/w/${w.slug}` });
    expect(get.data.upcoming_sessions[0]).toMatchObject({ start: '2026-11-09T18:00:00.000Z' });
    expect(get.data.settings.reminders.map((r: any) => r.key)).toEqual(['24h', '1h', '15m', 'start']);
    expect(get.data.settings.reminders[0]).not.toHaveProperty('body');
    const reg = await mcp('ghl_webinar_register', { location_id: loc, webinar_id: w.id, email: 'mcp@example.com', first_name: 'Mia' });
    expect(reg.isError, reg.text).toBe(false);
    expect(reg.data).toMatchObject({ created: true, session: { start: '2026-11-09T18:00:00.000Z' } });
    expect(reg.data.join_url).toContain('/watch?t=');
    const again = await mcp('ghl_webinar_register', { location_id: loc, webinar_id: w.id, email: 'mcp@example.com', first_name: 'Mia' });
    expect(again.data.created).toBe(false);
    const stats = await mcp('ghl_webinar_stats', { location_id: loc, webinar_id: w.id });
    expect(stats.data.totals).toMatchObject({ registrations: 1, attended: 0 });
    expect(stats.data.dropoff).toHaveLength(21);
    // the write is in the audit log with the way it came in
    const rows = audit('webinars.registrations.create');
    expect(rows.some((r) => r.via === 'mcp')).toBe(true);
    // errors are readable
    const gone = await mcp('ghl_webinar_get', { location_id: loc, webinar_id: 'gibt-es-nicht' });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/nicht gefunden/);
  });

  it('never reaches another sub-account’s webinar', async () => {
    t.api.setLocation(other);
    const theirs = await make('MARKB Fremd', READY);
    t.api.setLocation(loc);
    for (const [name, args] of [['ghl_webinar_get', { webinar_id: theirs.id }], ['ghl_webinar_stats', { webinar_id: theirs.id }], ['ghl_webinar_register', { webinar_id: theirs.id, email: 'x@example.com', first_name: 'X' }]] as const) {
      const r = await mcp(name, { location_id: loc, ...args });
      expect(r.isError, name).toBe(true);
      expect(r.text).not.toContain('MARKB');
    }
    expect((await mcp('ghl_webinar_list', { location_id: loc })).text).not.toContain('MARKB');
    // a key of A naming B's location is refused
    expect((await mcp('ghl_webinar_list', { location_id: other })).isError).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ?', theirs.id)!.n).toBe(0);
  });
});

describe('the app’s endpoints', () => {
  let token = '';
  let limitedToken = '';
  let w: any;
  beforeAll(async () => {
    token = (await member('POST', '/api/mobile/pair', { device_name: 'Pixel' })).data.token;
    limitedToken = (await limited('POST', '/api/mobile/pair', { device_name: 'Handy' })).data.token;
    w = await make('App-Webinar', READY);
    await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' });
    await t.api.post(`/api/webinars/${w.id}/registrations`, { email: 'app@example.com', first_name: 'Ann', session: '2026-11-09T18:00:00.000Z' });
  });
  const app = (path: string, tok = token) => t.api.raw(path, { headers: { authorization: `Bearer ${tok}` } }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));

  it('lists, shows and counts – read only', async () => {
    const list = await app(`/api/mobile/webinars?location=${loc}`);
    expect(list.status).toBe(200);
    const row = list.data.webinars.find((x: any) => x.id === w.id);
    expect(row).toMatchObject({ location_id: loc, location_name: 'Testfirma', title: 'App-Webinar', status: 'published', registrations: 1, next_session: '2026-11-09T18:00:00.000Z', duration_s: 1800 });
    expect(list.data.webinars.every((x: any) => x.location_id === loc)).toBe(true);
    expect((await app(`/api/mobile/webinars?status=draft&location=${loc}`)).data.webinars.every((x: any) => x.status === 'draft')).toBe(true);
    expect((await app(`/api/mobile/webinars?status=kaputt`)).status).toBe(400);
    const one = await app(`/api/mobile/webinars/${w.id}`);
    expect(one.data).toMatchObject({ id: w.id, title: 'App-Webinar', counts: { registrations: 1 }, time_zone: 'Europe/Berlin' });
    expect(one.data.upcoming[0]).toMatchObject({ start: '2026-11-09T18:00:00.000Z', taken: 1 });
    const stats = await app(`/api/mobile/webinars/${w.id}/stats`);
    expect(stats.data.totals.registrations).toBe(1);
    expect(stats.data.dropoff).toHaveLength(21);
    expect((await t.api.raw(`/api/mobile/webinars/${w.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it('keeps to the member areas and the sub-accounts of the login', async () => {
    expect((await app(`/api/mobile/webinars?location=${loc}`, limitedToken)).status).toBe(403);
    expect((await app(`/api/mobile/webinars/${w.id}`, limitedToken)).status).toBe(403);
    expect((await app(`/api/mobile/webinars/${w.id}/stats`, limitedToken)).status).toBe(403);
    expect((await app(`/api/mobile/webinars/gibt-es-nicht`)).status).toBe(404);
    expect((await app(`/api/mobile/webinars?location=${other}`)).status).toBe(403);
    expect((await t.api.raw('/api/mobile/webinars')).status).toBe(401);
    // a device token cannot use the team's routes
    expect((await app('/api/webinars')).status).toBe(403);
  });
});
